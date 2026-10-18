import { createPosting } from "../payments/posting.mjs";
// One tick is bounded. Provider I/O occurs only between short committed database transactions.
export function createPaymentWorker(store, adapter) {
  const eid = adapter.environment.id,
    post = createPosting(store);
  const query = (sql, args = []) =>
    store.workerTx(async (c) => (await c.query(sql, args)).rows[0]?.result);
  async function dispatch() {
    const op = await query("SELECT campus.money_claim($1) AS result", [eid]);
    if (!op) return false;
    try {
      let value;
      if (op.kind === "checkout") {
        value = await adapter.createCheckout(op);
        await query(
          "SELECT campus.money_operation_result($1,$2,$3) AS result",
          [
            op.id,
            op.fence,
            JSON.stringify({
              status: "succeeded",
              id: value.id,
              url: value.url,
              expiresAt: value.expires_at,
              requestId: value.lastResponse?.requestId ?? null,
            }),
          ],
        );
      } else if (op.kind === "transfer") {
        value = await adapter.createTransfer(op);
        await post.transfer(op, value);
      } else if (op.kind === "expire") {
        // Expire may have succeeded before a lost response, or the session may
        // already be complete. Only the subsequent exact read decides inventory.
        try {value=await adapter.expireCheckout(op);} catch {value=null;}
        const expected = await query(
          "SELECT campus.money_find_attempt($1,$2) AS result",
          [eid, op.payload.sessionId],
        );
        if (!expected) throw Error('dependency_not_ready');
        const objects=await adapter.retrieveCheckoutAndPayment(expected.sessionId);
        await post.payment(expected,objects);
        await query(
          "SELECT campus.money_operation_result($1,$2,$3) AS result",
          [
            op.id,
            op.fence,
            JSON.stringify({ status: objects.session.status === "open" ? "unknown" : "succeeded", id: value?.id??op.payload.sessionId }),
          ],
        );
      } else if (op.kind === "refund" || op.kind === "reversal" || op.kind === "fee_restitution") {
        value = op.provider_id
          ? (op.kind !== "reversal" ? await adapter.retrieveRefund(op.provider_id) : await adapter.retrieveReversal(op.payload.transferId,op.provider_id))
          : (op.kind !== "reversal" ? await adapter.createRefund(op) : await adapter.reverseTransfer(op));
        const settled = await post.compensation(
          op,
          value,
          await adapter.compensationBalances(value),
        );
        if (!settled)
          await query(
            "SELECT campus.money_operation_result($1,$2,$3) AS result",
            [op.id, op.fence, JSON.stringify({ status: "unknown" })],
          );
      } else if (op.kind === "recipient") {
        value = await adapter.createRecipient(op);
        await query(
          "SELECT campus.money_recipient_created($1,$2,$3) AS result",
          [op.id, op.fence, value.id],
        );
      } else if (op.kind === "onboarding") {
        value = await adapter.createOnboarding(op);
        if(value.account!==op.payload.accountId || value.livemode!==(adapter.environment.mode==='live') || !Number.isFinite(Date.parse(value.expires_at)))throw Error('provider_fact_mismatch');
        await query(
          "SELECT campus.money_operation_result($1,$2,$3) AS result",
          [
            op.id,
            op.fence,
            JSON.stringify({
              status: "succeeded",
              id: value.object ?? "account_link",
              url: value.url,
              expiresAt:value.expires_at,
            }),
          ],
        );
      } else throw Error("unsupported_operation");
    } catch (error) {
      const noEffect=op.kind==='checkout'&&Number(op.fence)===1&&error.type==='StripeInvalidRequestError'&&error.statusCode===400&&['parameter_invalid_integer','parameter_unknown','parameter_missing'].includes(error.code);
      await query("SELECT campus.money_operation_result($1,$2,$3) AS result", [
        op.id,
        op.fence,
        JSON.stringify({ status: noEffect ? "failed_no_effect" : "unknown", ...(noEffect?{code:error.code}:{}) }),
      ]);
    }
    return true;
  }
  async function inbox() {
    const row = await query("SELECT campus.money_inbox_claim($1) AS result", [
      eid,
    ]);
    if (!row) return false;
    let code = "processed";
    try {
      if (row.parser === "thin") {
        const notification = await adapter.retrieveThinEvent(
          row.event_id,
          row.payload.context,
        );
        const accountId =
          notification.related_object?.id ?? notification.data?.account_id;
        const targets = await query(
          "SELECT campus.money_account_targets($1) AS result",
          [eid],
        );
        const bound = targets.find((t) => t.accountId === accountId);
        if (!bound) throw Error("thin_account_dependency_not_ready");
        await query("SELECT campus.money_observe_account($1,$2,$3) AS result", [
          eid,
          bound.userId,
          JSON.stringify(
            await adapter.retrieveRecipientCapabilities(bound.accountId),
          ),
        ]);
        await query("SELECT campus.money_inbox_finish($1,$2,$3) AS result", [
          row.id,
          row.fence,
          "processed",
        ]);
        return true;
      }
      const object = row.payload.data?.object;
      if (
        row.event_type.startsWith("checkout.session.") ||
        row.event_type.startsWith("payment_intent.") || row.event_type==='charge.updated'
      ) {
        if (row.origin_account !== adapter.environment.platformAccountId)
          throw Error("provider_scope_mismatch");
        const expected = await query(
          "SELECT campus.money_find_attempt($1,$2) AS result",
          [eid, object?.id],
        );
        if (!expected) throw Error("dependency_not_ready");
        await post.payment(
          { ...expected, inboxId: row.id },
          await adapter.retrieveCheckoutAndPayment(expected.sessionId),
        );
      } else if (row.event_type.startsWith("transfer.")) {
        if (row.origin_account !== adapter.environment.platformAccountId)
          throw Error("provider_scope_mismatch");
        const transfer = await adapter.retrieveTransfer(object.id);
        const op = await query(
          "SELECT campus.money_find_operation($1,$2,$3) AS result",
          [eid, transfer.id, transfer.metadata?.operationId ?? null],
        );
        if (!op) throw Error("dependency_not_ready");
        await post.transfer(op, transfer);
        if (row.event_type === "transfer.reversed") {
          const page = await adapter.listReversals(
            transfer.id,
            row.reconciliation_cursor,
          );
          for (const listed of page.data) {
            const reversal = await adapter.retrieveReversal(
              transfer.id,
              listed.id,
            );
            const reversalOp = await query(
              "SELECT campus.money_find_operation($1,$2,$3) AS result",
              [eid, reversal.id, reversal.metadata?.operationId ?? null],
            );
            if (reversalOp)
              await post.compensation(
                reversalOp,
                reversal,
                await adapter.compensationBalances(reversal),
              );
            else
              await post.externalCompensation(
                "reversal",
                reversal,
                await adapter.compensationBalances(reversal),
                {
                  environmentId: eid,
                  chargeId: op.payload.sourceCharge,
                  transferId: transfer.id,
                  originalOperationId: op.id,
                  amountCents: op.payload.amountCents,
                },
              );
          }
          if (page.has_more) {
            if (!page.data.length) throw Error("provider_fact_mismatch");
            await query(
              "SELECT campus.money_inbox_cursor($1,$2,$3) AS result",
              [row.id, row.fence, page.data.at(-1).id],
            );
            throw Error("reversal_page_remaining");
          }
        }
      } else if (row.event_type.startsWith("refund.")) {
        if (row.origin_account !== adapter.environment.platformAccountId)
          throw Error("provider_scope_mismatch");
        const refund = await adapter.retrieveRefund(object.id);
        const op = await query(
          "SELECT campus.money_find_operation($1,$2,$3) AS result",
          [eid, refund.id, refund.metadata?.operationId ?? null],
        );
        if (op)
          await post.compensation(
            op,
            refund,
            await adapter.compensationBalances(refund),
          );
        else {
          const chargeId =
            typeof refund.charge === "string"
              ? refund.charge
              : refund.charge?.id;
          const expected = await query("SELECT campus.money_find_receipt($1,$2) AS result",[eid,chargeId]);
          if(!expected)throw Error('dependency_not_ready');
          const charge=await adapter.retrieveCharge(chargeId);
          if(charge?.id!==chargeId||charge.amount!==Number(expected.amountCents)||charge.currency!=='usd'||charge.livemode!==(expected.mode==='live')||(typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id)!==expected.intentId)throw Error('provider_fact_mismatch');
          await post.externalCompensation(
            "refund",
            refund,
            await adapter.compensationBalances(refund),
            { environmentId: eid, chargeId, amountCents: expected.amountCents },
          );
        }
      } else if (row.event_type.startsWith("charge.dispute.")) {
        if (row.origin_account !== adapter.environment.platformAccountId)
          throw Error("provider_scope_mismatch");
        await query("SELECT campus.money_reconcile_schedule($1,'dispute',$2,'{}'::jsonb)",[eid,object.id]);
        await reconcileDispute(object.id);
      } else if (row.event_type.startsWith("payout.")) {
        if (row.origin_account === adapter.environment.platformAccountId)
          throw Error("provider_scope_mismatch");
        const payout = await adapter.retrievePayout(
          object.id,
          row.origin_account,
        );
        if (
          payout.id !== object.id ||
          payout.livemode !== (adapter.environment.mode === "live")
        )
          throw Error("provider_scope_mismatch");
        await query(
          "SELECT campus.money_payout_observe($1,$2,$3,$4) AS result",
          [eid, row.origin_account, payout.id, payout.status],
        );
      } else throw Error("event_requires_reconciliation");
    } catch (e) {
      code = /^[a-z_]+$/.test(e.message)
        ? e.message
        : "provider_retrieval_unknown";
    }
    await query("SELECT campus.money_inbox_finish($1,$2,$3) AS result", [
      row.id,
      row.fence,
      code,
    ]);
    return true;
  }
  async function reconcileDispute(objectId) {
    const dispute=await adapter.retrieveDispute(objectId);
    if(dispute.id!==objectId||dispute.livemode!==(adapter.environment.mode==='live'))throw Error('provider_scope_mismatch');
    const chargeId=typeof dispute.charge==='string'?dispute.charge:dispute.charge?.id;
    await query("SELECT campus.money_network_case($1,$2,$3) AS result",[eid,chargeId,dispute.id]);
    let available=true;
    for(const entry of dispute.balance_transactions??[]) {
      const b=await adapter.retrieveBalance(entry.id);
      if(b.id!==entry.id||b.amount!==entry.amount||b.net!==entry.net||b.currency!=='usd'||!Number.isSafeInteger(b.net))throw Error('provider_fact_mismatch');
      if(b.net>0&&b.status!=='available')available=false;
      if(b.net!==0)await query("SELECT campus.money_network_fact($1,$2,$3) AS result",[eid,chargeId,JSON.stringify({currency:'usd',chargeId,balanceTransactionId:b.id,disputeId:dispute.id,kind:b.net<0?'debit':'credit',amountCents:Math.abs(b.net),available:b.status==='available'})]);
    }
    return available&&['won','lost','warning_closed'].includes(dispute.status);
  }
  async function reconcile() {
    const job=await query("SELECT campus.money_reconcile_claim($1) AS result",[eid]);
    if(!job)return false;
    let code='pending';
    try {
      if(job.kind==='attempt') {
        const expected=await query("SELECT campus.money_find_attempt($1,$2) AS result",[eid,job.resource_key]);
        if(!expected)throw Error('dependency_not_ready');
        const objects=await adapter.retrieveCheckoutAndPayment(expected.sessionId);
        await post.payment(expected,objects);
        if((objects.session.status==='expired'&&(!objects.intent||objects.intent.status==='canceled'))||(objects.intent?.status==='succeeded'&&objects.balance?.status==='available'&&Number.isSafeInteger(objects.balance.fee)&&await query("SELECT campus.money_attempt_reconciled($1) AS result",[expected.id])))code='done';
      } else if(job.kind==='compensation') {
        const op=await query("SELECT campus.money_find_operation($1,NULL,$2) AS result",[eid,job.resource_key]);
        if(!op?.provider_id)throw Error('dependency_not_ready');
        const object=op.kind!=='reversal'?await adapter.retrieveRefund(op.provider_id):await adapter.retrieveReversal(op.payload.transferId,op.provider_id);
        const balances=await adapter.compensationBalances(object);
        const settled=await post.compensation(op,object,balances);
        if(settled&&balances.original&&Object.values(balances).filter(Boolean).every(b=>b.status==='available'))code='done';
      } else if(job.kind==='external_refund'||job.kind==='external_reversal') {
        const kind=job.kind==='external_refund'?'refund':'reversal',expected=job.payload;
        const object=kind==='refund'?await adapter.retrieveRefund(job.resource_key):await adapter.retrieveReversal(expected.transferId,job.resource_key);
        const balances=await adapter.compensationBalances(object);
        await post.externalCompensation(kind,object,balances,expected);
        if(balances.original&&Object.values(balances).filter(Boolean).every(b=>b.status==='available')&&(kind==='reversal'||object.status==='succeeded'||(['failed','canceled'].includes(object.status)&&balances.failure)))code='done';
      } else if(job.kind==='dispute') {
        if(await reconcileDispute(job.resource_key))code='done';
      }
    } catch(e) {code=/^[a-z_]+$/.test(e.message)?e.message:'provider_retrieval_unknown';}
    await query("SELECT campus.money_reconcile_finish($1,$2,$3) AS result",[job.id,job.fence,code]);
    return true;
  }
  async function fees() {
    for(const kind of ['balances','reports']) {
      const scan=await query("SELECT campus.money_fee_scan_claim($1,$2) AS result",[eid,kind]);if(!scan)continue;
      let code='processed',cursor=null;
      try {
        const page=kind==='balances'?await adapter.listFeeBalances(scan.cursor):await adapter.listFeeReports(scan.cursor);
        if(!Array.isArray(page.data)||page.data.length>16||(page.has_more&&!page.data.length))throw Error('provider_fact_mismatch');
        for(const item of page.data) {
          if(kind==='balances') {
            const b=await adapter.retrieveBalance(item.id);
            if(b.id!==item.id||b.type!=='stripe_fee'||b.currency!=='usd'||![b.amount,b.fee,b.net].every(Number.isSafeInteger)||b.net!==b.amount-b.fee)throw Error('provider_fact_mismatch');
            if(b.net<0)await query("SELECT campus.money_fee_cash($1,$2) AS result",[eid,JSON.stringify(b)]);
          } else if(item.report_type==='all_fees.balance_transaction_created.itemized.2')await query("SELECT campus.money_fee_report_schedule($1,$2) AS result",[eid,item.id]);
        }
        cursor=page.has_more?page.data.at(-1).id:null;
      }catch(e){code=/^[a-z_]+$/.test(e.message)?e.message:'provider_retrieval_unknown';}
      await query("SELECT campus.money_fee_scan_finish($1,$2,$3,$4,$5) AS result",[eid,kind,scan.fence,cursor,code]);
    }
    const job=await query("SELECT campus.money_fee_report_claim($1) AS result",[eid]);
    if(job){let code='pending';try{const report=await adapter.retrieveFeeReport(job.run_id);if(report.status==='succeeded'){const accepted=await query("SELECT campus.money_fee_report($1,$2) AS result",[eid,JSON.stringify(report)]);code=accepted?'processed':'report_conflict';}else if(report.status==='failed')code='failed';}catch(e){code=/^[a-z_]+$/.test(e.message)?e.message:'provider_retrieval_unknown';}await query("SELECT campus.money_fee_report_finish($1,$2,$3,$4) AS result",[eid,job.run_id,job.fence,code]);}
    for(const id of await query("SELECT campus.money_fee_attribution_targets($1) AS result",[eid]))await query("SELECT campus.money_fee_attribute($1,$2) AS result",[eid,id]);
  }
  async function refreshRecipients() {
    const targets = await query(
      "SELECT campus.money_account_refresh_targets($1) AS result",
      [eid],
    );
    for (const t of targets) {
      try {
        await query("SELECT campus.money_observe_account($1,$2,$3) AS result", [
          eid,
          t.userId,
          JSON.stringify(
            await adapter.retrieveRecipientCapabilities(t.accountId),
          ),
        ]);
      } catch {
        /* Unknown observations never upgrade capability. */
      }
    }
  }
  return {
    dispatch,
    inbox,
    reconcile,
    fees,
    refreshRecipients,
    async tick() {
      for(const orderId of await query("SELECT campus.money_expiry_targets($1) AS result",[eid]))await query("SELECT campus.money_expire_order($1,$2) AS result",[eid,orderId]);
      await fees();
      const reconciled=await reconcile();
      await refreshRecipients();
      const targets = await query(
        "SELECT campus.money_work_targets($1) AS result",
        [eid],
      );
      for (const obligationId of targets) {
        await query("SELECT campus.money_fee_report_close($1,$2) AS result",[eid,obligationId]);
        await query("SELECT campus.money_prepare_restitution($1,$2) AS result",[eid,obligationId]);
        await query(
          "SELECT campus.money_prepare_compensation($1,$2) AS result",
          [eid, obligationId],
        );
        await query("SELECT campus.money_prepare_transfers($1,$2) AS result", [
          eid,
          obligationId,
        ]);
      }
      const sent = await dispatch();
      const received = await inbox();
      return { dispatched: sent, inboxProcessed: received, reconciled };
    },
  };
}
