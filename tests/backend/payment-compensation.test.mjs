import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { paymentWebhook } from "../../backend/http/payment-webhook.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./payment-money-fixture.mjs";
import {
  fakeTransport,
  fundedAgreement,
  earnAndOnboard,
} from "./payment-money-scenarios.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
import { createPosting } from "../../backend/payments/posting.mjs";
test("approved scoped refund reserves principal; unknown keeps reservation; duplicate fact once; external network debit survives participant hold; mock", async () => {
  const f = await isolated(0);
  try {
    await f.migrateThrough(20);
    const env = {
      id: key(),
      platformAccountId: "acct_compensation",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B compensation synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const t = fakeTransport(),
      adapter = createStripePayments({ client: t.client, environment: env }),
      worker = createPaymentWorker(f.store, adapter),
      post = createPosting(f.store);
    const s = await fundedAgreement(f, env, worker, adapter, t, post);
    const sdk = new Stripe("synthetic-no-network"),
      secret = "whsec_" + randomBytes(24).toString("hex");
    t.client.webhooks = sdk.webhooks;
    const ingress = createStripePayments({
      client: t.client,
      environment: env,
      snapshotSecret: secret,
    });
    const handler = paymentWebhook(async () => ({
      paymentAdapter: ingress,
      store: f.store,
    }));
    const session = [...t.sessions.values()][0];
    async function deliver(event) {
      const body = JSON.stringify(event);
      return handler(
        new Request("http://127.0.0.1/api/v1/webhooks/stripe", {
          method: "POST",
          body,
          headers: {
            "stripe-signature": sdk.webhooks.generateTestHeaderString({
              payload: body,
              secret,
            }),
          },
        }),
      );
    }
    const event = {
      id: "evt_" + key(),
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: session.id } },
    };
    assert.equal((await deliver(event)).status, 200);
    assert.equal((await deliver(event)).status, 200);
    assert.equal(
      (await deliver({ ...event, type: "checkout.session.expired" })).status,
      400,
      "Conflicting duplicate bytes rejected",
    );
    assert.equal(
      (
        await deliver({
          ...event,
          id: "evt_" + key(),
          type: "checkout.session.expired",
        })
      ).status,
      200,
    );
    assert.equal(
      (await deliver({ ...event, id: "evt_" + key(), account: "acct_foreign" }))
        .status,
      400,
    );
    await worker.inbox();
    await worker.inbox();
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_receipt_observations",
        )
      ).rows[0].n,
      2,
      "Two distinct authenticated notifications link to one semantic receipt fact",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(DISTINCT receipt_fact_id)::int n FROM campus.payment_receipt_observations",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.provider_inbox WHERE status='processed'",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.ledger_journals WHERE source_effect LIKE 'receipt:%'",
        )
      ).rows[0].n,
      1,
      "Out-of-order expired signal retrieves current success and does not double post",
    );
    const projection = await f.market.agreementFunding(s.P, s.g.id);
    const request = (
      await f.market.requestPaymentRefund(
        s.P,
        "agreement",
        s.g.id,
        {
          obligationId: s.q.obligationId,
          expectedPaymentRevision: projection.paymentRevision,
          chargeId: s.charge.id,
          amountCents: 1000,
          reason: "Synthetic approved partial refund",
          policyVersionId: s.policyId,
        },
        key(),
      )
    ).receipt;
    assert.equal(request.refundStatus, "not_executed");
    const component = (
      await f.owner.query(
        "SELECT c.* FROM campus.funding_component_plans c JOIN campus.funding_lots l ON l.id=c.lot_id WHERE l.obligation_id=$1",
        [s.q.obligationId],
      )
    ).rows[0];
    const holds = (
      await f.owner.query(
        "SELECT id FROM campus.payment_holds WHERE obligation_id=$1 AND active",
        [s.q.obligationId],
      )
    ).rows.map((r) => r.id);
    async function decision(amount, version, purpose = "refund") {
      const id = key(),
        pid = key(),
        payload = {
          decisionId: id,
          componentId: component.id,
          amountCents: amount,
          approvedHoldIds: holds,
        };
      await f.owner.query(
        "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,$4,$5,'approved',$6,$7,'Task2B synthetic exact approved compensation')",
        [
          pid,
          env.id,
          s.g.id,
          purpose,
          version,
          JSON.stringify(payload),
          digest(payload),
        ],
      );
      await f.owner.query(
        "INSERT INTO campus.payment_compensation_decisions(id,environment_id,obligation_id,policy_id,request_id,case_revision,component_id,kind,amount_cents,provenance) VALUES($1,$2,$3,$4,$5,1,$6,'refund',$7,'Task2B synthetic exact decision')",
        [
          id,
          env.id,
          s.q.obligationId,
          pid,
          version === 1 ? request.requestId : null,
          component.id,
          amount,
        ],
      );
      return id;
    }
    await decision(1000, 1);
    const results = await Promise.all([
      f.store.workerTx((c) =>
        c.query("SELECT campus.money_prepare_compensation($1) AS n", [env.id]),
      ),
      f.store.workerTx((c) =>
        c.query("SELECT campus.money_prepare_compensation($1) AS n", [env.id]),
      ),
    ]);
    assert.equal(
      results.reduce((n, r) => n + r.rows[0].n, 0),
      1,
      "Ordinary concurrent prepare reserves once",
    );
    const op = (
      await f.owner.query(
        "SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund'",
        [s.q.obligationId],
      )
    ).rows[0];
    const create = t.client.refunds.create;
    let actual;
    t.client.refunds.create = async (p) => {
      actual = await create(p);
      throw Error("synthetic lost response");
    };
    await worker.dispatch();
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_reservations WHERE operation_id=$1",
          [op.id],
        )
      ).rows[0].status,
      "reserved",
    );
    await decision(9000, 2);
    await decision(100, 3, "collection");
    await f.store.workerTx((c) =>
      c.query("SELECT campus.money_prepare_compensation($1)", [env.id]),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund'",
          [s.q.obligationId],
        )
      ).rows[0].n,
      1,
      "Overspend and foreign-purpose decision cannot create operations",
    );
    await post.compensation(
      op,
      actual,
      await adapter.compensationBalances(actual),
    );
    await post.compensation(
      op,
      actual,
      await adapter.compensationBalances(actual),
    );
    assert.equal(
      (await f.market.agreementFunding(s.P, s.g.id)).refundedCents,
      "1000",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.ledger_journals WHERE source_effect LIKE 'refund:%'",
        )
      ).rows[0].n,
      1,
    );
    const headroom = async () =>
      Number(
        (
          await f.owner.query(
            "SELECT campus.money_cash_headroom($1,NULL,$2) AS n",
            [env.id, component.lot_id],
          )
        ).rows[0].n,
      );
    assert.equal(
      await headroom(),
      8850,
      "Original301 fee counted once and refund1000 deducted once",
    );
    await decision(1000, 4);
    await f.store.workerTx((c) =>
      c.query("SELECT campus.money_prepare_compensation($1,$2)", [
        env.id,
        s.q.obligationId,
      ]),
    );
    const pendingOp = (
      await f.owner.query(
        "SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund' AND status='queued'",
        [s.q.obligationId],
      )
    ).rows[0];
    t.client.refunds.create = async (p, opts) => {
      const r = await create(p, opts);
      r.status = "pending";
      return r;
    };
    await worker.dispatch();
    const pendingRefund = [...t.refunds.values()].find(
      (r) => r.metadata.operationId === pendingOp.id,
    );
    assert.equal(
      await headroom(),
      7850,
      "Observed pending debit replaces cash reservation instead of double subtraction",
    );
    t.failRefund(pendingRefund.id, { available: false });
    assert.equal(
      (
        await deliver({
          id: "evt_" + key(),
          type: "refund.failed",
          livemode: false,
          data: { object: { id: pendingRefund.id } },
        })
      ).status,
      200,
    );
    await worker.inbox();
    assert.equal(
      await headroom(),
      7850,
      "Pending refund-failure credit does not create availability",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_reservations WHERE operation_id=$1",
          [pendingOp.id],
        )
      ).rows[0].status,
      "reserved",
    );
    t.failRefund(pendingRefund.id, { available: true });
    for (let n = 0; n < 2; n++) {
      assert.equal(
        (
          await deliver({
            id: "evt_" + key(),
            type: "refund.failed",
            livemode: false,
            data: { object: { id: pendingRefund.id } },
          })
        ).status,
        200,
      );
      await worker.inbox();
    }
    assert.equal(
      await headroom(),
      8850,
      "Exact available failed-refund credit restores cash once",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_reservations WHERE operation_id=$1",
          [pendingOp.id],
        )
      ).rows[0].status,
      "released",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_balance_facts WHERE operation_id=$1",
          [pendingOp.id],
        )
      ).rows[0].n,
      2,
    );
    const network = {
      chargeId: s.charge.id,
      currency: "usd",
      balanceTransactionId: "txn_network_" + key(),
      disputeId: "dp_" + key(),
      kind: "debit",
      amountCents: 20000,
    };
    const dispute = {
      id: network.disputeId,
      charge: s.charge.id,
      livemode: false,
      balance_transactions: [],
    };
    t.client.disputes = {
      async retrieve() {
        return dispute;
      },
    };
    const debitBalance = {
      id: network.balanceTransactionId,
      source: network.disputeId,
      amount: -20000,
      net: -20000,
      fee: 0,
      currency: "usd",
      status: "available",
    };
    t.balances.set(debitBalance.id, debitBalance);
    dispute.balance_transactions.push({ ...debitBalance });
    for (let n = 0; n < 2; n++) {
      await deliver({
        id: "evt_" + key(),
        type: "charge.dispute.funds_withdrawn",
        livemode: false,
        data: { object: { id: dispute.id } },
      });
      await worker.inbox();
    }

    const cash = (
      await f.owner.query(
        "SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.lot_id=$1 AND ll.account='cash'",
        [component.lot_id],
      )
    ).rows[0].n;
    assert.equal(cash, "-11150");
    assert.equal(
      (await f.market.agreementFunding(s.P, s.g.id)).coverage,
      "held",
    );
    t.client.refunds.create = create;
    const other = await fundedAgreement(f, env, worker, adapter, t, post);
    assert.equal(
      await headroom(),
      -1300,
      "Available independent source cannot hide existing negative environment cash",
    );
    await earnAndOnboard(f, other, env, worker);
    const ready = (
      await f.owner.query(
        "SELECT p.release_ready,p.net_cents,p.operation_id,a.transfer_capability,c.member_id,l.id lot FROM campus.payables p JOIN campus.funding_lots l ON l.id=p.lot_id JOIN campus.funding_component_plans c ON c.id=p.component_id JOIN campus.connected_payee_accounts a ON a.environment_id=p.environment_id AND a.user_id=c.member_id WHERE l.obligation_id=$1",
        [other.q.obligationId],
      )
    ).rows[0];
    assert.equal(ready.release_ready, true);
    assert.equal(ready.transfer_capability, "active");
    assert.equal(Number(ready.net_cents), 9850);
    assert.equal(
      Number(
        (
          await f.owner.query("SELECT campus.money_cash_headroom($1,$2) n", [
            env.id,
            ready.lot,
          ])
        ).rows[0].n,
      ),
      9850,
    );
    assert.equal(
      (
        await f.store.workerTx((c) =>
          c.query("SELECT campus.money_prepare_transfers($1,$2) n", [
            env.id,
            other.q.obligationId,
          ]),
        )
      ).rows[0].n,
      0,
      "Earned recipient-ready source with positive own cash is blocked by environment deficit",
    );
    const pendingSource = await fundedAgreement(
      f,
      env,
      worker,
      adapter,
      t,
      post,
      { available: false },
    );
    assert.equal(
      await headroom(),
      -1300,
      "Pending receipt book cash does not increase verified environment availability",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.money_operations WHERE kind='transfer' AND obligation_id=ANY($1::uuid[])",
          [[other.q.obligationId, pendingSource.q.obligationId]],
        )
      ).rows[0].n,
      0,
    );
    const credit = {
      id: "txn_" + key(),
      source: dispute.id,
      amount: 20000,
      net: 20000,
      fee: 0,
      currency: "usd",
      status: "pending",
    };
    t.balances.set(credit.id, credit);
    dispute.balance_transactions.push({ ...credit });
    await deliver({
      id: "evt_" + key(),
      type: "charge.dispute.funds_reinstated",
      livemode: false,
      data: { object: { id: dispute.id } },
    });
    await worker.inbox();
    assert.equal(
      await headroom(),
      -1300,
      "Unverified network credit availability cannot release another source",
    );
    credit.status = "available";
    dispute.balance_transactions[1].status = "available";
    await deliver({
      id: "evt_" + key(),
      type: "charge.dispute.funds_reinstated",
      livemode: false,
      data: { object: { id: dispute.id } },
    });
    await worker.inbox();
    assert.equal(await headroom(), 18700);
    assert.equal(
      (
        await f.store.workerTx((c) =>
          c.query("SELECT campus.money_prepare_transfers($1,$2) n", [
            env.id,
            other.q.obligationId,
          ]),
        )
      ).rows[0].n,
      1,
    );
    await worker.dispatch();
    assert.equal(t.transfers.size, 1);
    // Contradictory terminal status is factual cash evidence, not new principal authority.
    t.failRefund(actual.id, { available: true });
    for (let i = 0; i < 2; i++) {
      await deliver({
        id: "evt_" + key(),
        type: "refund.failed",
        livemode: false,
        data: { object: { id: actual.id } },
      });
      await worker.inbox();
    }
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_reservations WHERE operation_id=$1",
          [op.id],
        )
      ).rows[0].status,
      "consumed",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_balance_facts WHERE operation_id=$1",
          [op.id],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_holds WHERE obligation_id=$1 AND reason='compensation_terminal_conflict' AND active",
          [s.q.obligationId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT campus.money_cash_headroom($1,$2)::text n",
          [env.id, component.lot_id],
        )
      ).rows[0].n,
      "0",
    );
    const priorRefundCount = (
      await f.owner.query(
        "SELECT count(*)::int n FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund'",
        [s.q.obligationId],
      )
    ).rows[0].n;
    await f.store.workerTx((c) =>
      c.query("SELECT campus.money_prepare_compensation($1,$2)", [
        env.id,
        s.q.obligationId,
      ]),
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund'",
          [s.q.obligationId],
        )
      ).rows[0].n,
      priorRefundCount,
    );
  } finally {
    await f.close();
  }
});
test("verified reversal pending/available restores exact original component; approved refund consumes it once through worker; mock", async () => {
  const f = await isolated(0);
  try {
    await f.migrateThrough(20);
    const env = {
      id: key(),
      platformAccountId: "acct_reversal",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B reversal synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const t = fakeTransport(),
      adapter = createStripePayments({ client: t.client, environment: env }),
      worker = createPaymentWorker(f.store, adapter),
      post = createPosting(f.store);
    const s = await fundedAgreement(f, env, worker, adapter, t, post);
    await earnAndOnboard(f, s, env, worker);
    await worker.tick();
    const transfer = (
      await f.owner.query(
        "SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='transfer'",
        [s.q.obligationId],
      )
    ).rows[0];
    assert.equal(transfer.status, "succeeded");
    const component = transfer.payload.componentId;
    async function authorize(kind, version, holds = []) {
      const id = key(),
        pid = key(),
        payload = {
          decisionId: id,
          componentId: component,
          amountCents: 1000,
          approvedHoldIds: holds,
        };
      await f.owner.query(
        "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,$4,$5,'approved',$6,$7,'Task2B exact synthetic compensation authorization')",
        [
          pid,
          env.id,
          s.g.id,
          kind,
          version,
          JSON.stringify(payload),
          digest(payload),
        ],
      );
      await f.owner.query(
        "INSERT INTO campus.payment_compensation_decisions(id,environment_id,obligation_id,policy_id,case_revision,component_id,kind,amount_cents,original_operation_id,provenance) VALUES($1,$2,$3,$4,1,$5,$6,1000,$7,'Task2B synthetic decision')",
        [
          id,
          env.id,
          s.q.obligationId,
          pid,
          component,
          kind,
          kind === "reversal" ? transfer.id : null,
        ],
      );
    }
    await authorize("reversal", 1);
    const reverse = t.client.transfers.createReversal;
    t.client.transfers.createReversal = async (...args) => {
      const r = await reverse(...args);
      t.balances.get(r.balance_transaction).status = "pending";
      return r;
    };
    await worker.tick();
    const reversal = [...t.reversals.values()][0];
    assert.ok(reversal);
    const headroom = async () =>
      Number(
        (
          await f.owner.query(
            "SELECT campus.money_cash_headroom($1,NULL,(SELECT lot_id FROM campus.funding_component_plans WHERE id=$2)) n",
            [env.id, component],
          )
        ).rows[0].n,
      );
    assert.equal(await headroom(), 0, "Pending reversal cash is not available");
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.principal_restorations WHERE component_id=$1",
          [component],
        )
      ).rows[0].n,
      1,
    );
    t.balances.get(reversal.balance_transaction).status = "available";
    const sdk = new Stripe("synthetic-no-network"),
      secret = "whsec_" + randomBytes(24).toString("hex");
    t.client.webhooks = sdk.webhooks;
    const handler = paymentWebhook(async () => ({
      store: f.store,
      paymentAdapter: createStripePayments({
        client: t.client,
        environment: env,
        snapshotSecret: secret,
      }),
    }));
    for (let n = 0; n < 2; n++) {
      const body = JSON.stringify({
        id: "evt_" + key(),
        type: "transfer.reversed",
        livemode: false,
        data: { object: { id: transfer.provider_id } },
      });
      assert.equal(
        (
          await handler(
            new Request("http://127.0.0.1/api/v1/webhooks/stripe", {
              method: "POST",
              body,
              headers: {
                "stripe-signature": sdk.webhooks.generateTestHeaderString({
                  payload: body,
                  secret,
                }),
              },
            }),
          )
        ).status,
        200,
      );
      await worker.inbox();
    }
    assert.equal(await headroom(), 1000);
    assert.equal(
      (
        await f.owner.query(
          "SELECT transferred_cents::int n FROM campus.payables WHERE component_id=$1",
          [component],
        )
      ).rows[0].n,
      8850,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.principal_restorations WHERE component_id=$1",
          [component],
        )
      ).rows[0].n,
      1,
    );
    const holds = (
      await f.owner.query(
        "SELECT id FROM campus.payment_holds WHERE obligation_id=$1 AND active",
        [s.q.obligationId],
      )
    ).rows.map((r) => r.id);
    await authorize("refund", 1, holds);
    await worker.tick();
    assert.equal(await headroom(), 0);
    assert.equal(
      (await f.market.agreementFunding(s.P, s.g.id)).refundedCents,
      "1000",
    );
    const entries = (
      await f.owner.query(
        "SELECT sum(debit-credit)::text n FROM campus.ledger_lines WHERE component_id=$1 AND account='payable'",
        [component],
      )
    ).rows[0].n;
    assert.equal(entries, "0");
    async function deliverFact(type, id) {
      const body = JSON.stringify({
        id: "evt_" + key(),
        type,
        livemode: false,
        data: { object: { id } },
      });
      assert.equal(
        (
          await handler(
            new Request("http://127.0.0.1/api/v1/webhooks/stripe", {
              method: "POST",
              body,
              headers: {
                "stripe-signature": sdk.webhooks.generateTestHeaderString({
                  payload: body,
                  secret,
                }),
              },
            }),
          )
        ).status,
        200,
      );
      await worker.inbox();
    }
    // Simulated dashboard/provider actions: no local discretionary command is fabricated.
    const externalReversal = await t.client.transfers.createReversal(
      transfer.provider_id,
      { amount: 500, metadata: {} },
    );
    t.balances.get(externalReversal.balance_transaction).status = "available";
    await deliverFact("transfer.reversed", transfer.provider_id);
    await deliverFact("transfer.reversed", transfer.provider_id);
    assert.equal(await headroom(), 500);
    assert.equal(
      (
        await f.owner.query(
          "SELECT transferred_cents::int n FROM campus.payables WHERE component_id=$1",
          [component],
        )
      ).rows[0].n,
      8350,
    );
    const externalRefund = await t.client.refunds.create(
      { charge: s.charge.id, amount: 200, metadata: {} },
      { idempotencyKey: "external-" + key() },
    );
    await deliverFact("refund.created", externalRefund.id);
    await deliverFact("refund.created", externalRefund.id);
    assert.equal(await headroom(), 300);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_external_balance_facts",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      Number(
        (
          await f.owner.query("SELECT campus.money_cash_headroom($1,NULL) n", [
            env.id,
          ])
        ).rows[0].n,
      ),
      0,
      "Unallocated external effects remain held despite positive cash",
    );
    assert.equal(
      (await f.market.agreementFunding(s.P, s.g.id)).coverage,
      "held",
    );
  } finally {
    await f.close();
  }
});
test("other held positive liquidity excluded; own exact approved hold exception; later hold blocks frozen refund at dispatch; mock", async () => {
  const f = await isolated(0);
  try {
    await f.migrateThrough(20);
    const env = {
      id: key(),
      platformAccountId: "acct_holdscope",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B held liquidity synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const t = fakeTransport(),
      adapter = createStripePayments({ client: t.client, environment: env }),
      worker = createPaymentWorker(f.store, adapter),
      post = createPosting(f.store);
    const A = await fundedAgreement(f, env, worker, adapter, t, post),
      B = await fundedAgreement(f, env, worker, adapter, t, post);
    await f.market.openPaymentDispute(
      A.P,
      "agreement",
      A.g.id,
      {
        expectedPaymentRevision: (await f.market.agreementFunding(A.P, A.g.id))
          .paymentRevision,
        reason: "Synthetic unrelated held funds",
      },
      key(),
    );
    assert.equal(
      Number(
        (
          await f.owner.query("SELECT campus.money_cash_headroom($1,NULL) n", [
            env.id,
          ])
        ).rows[0].n,
      ),
      9850,
      "Held positive other lot contributes no spendable environment liquidity",
    );
    const req = (
      await f.market.requestPaymentRefund(
        B.P,
        "agreement",
        B.g.id,
        {
          obligationId: B.q.obligationId,
          expectedPaymentRevision: (
            await f.market.agreementFunding(B.P, B.g.id)
          ).paymentRevision,
          chargeId: B.charge.id,
          amountCents: 1000,
          reason: "Exact reviewed synthetic request",
          policyVersionId: B.policyId,
        },
        key(),
      )
    ).receipt;
    const cp = (
        await f.owner.query(
          "SELECT c.* FROM campus.funding_component_plans c JOIN campus.funding_lots l ON l.id=c.lot_id WHERE l.obligation_id=$1",
          [B.q.obligationId],
        )
      ).rows[0],
      holds = (
        await f.owner.query(
          "SELECT id FROM campus.payment_holds WHERE obligation_id=$1 AND active",
          [B.q.obligationId],
        )
      ).rows.map((r) => r.id);
    const id = key(),
      pid = key(),
      payload = {
        decisionId: id,
        componentId: cp.id,
        amountCents: 1000,
        approvedHoldIds: holds,
      };
    await f.owner.query(
      "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'refund',1,'approved',$4,$5,'Task2B exact own-lot synthetic decision')",
      [pid, env.id, B.g.id, JSON.stringify(payload), digest(payload)],
    );
    await f.owner.query(
      "INSERT INTO campus.payment_compensation_decisions(id,environment_id,obligation_id,policy_id,request_id,case_revision,component_id,kind,amount_cents,provenance) VALUES($1,$2,$3,$4,$5,1,$6,'refund',1000,'Task2B synthetic decision')",
      [id, env.id, B.q.obligationId, pid, req.requestId, cp.id],
    );
    assert.equal(
      Number(
        (
          await f.owner.query(
            "SELECT campus.money_cash_headroom($1,NULL,$2) n",
            [env.id, cp.lot_id],
          )
        ).rows[0].n,
      ),
      9850,
    );
    assert.equal(
      (
        await f.store.workerTx((c) =>
          c.query("SELECT campus.money_prepare_compensation($1,$2) n", [
            env.id,
            B.q.obligationId,
          ]),
        )
      ).rows[0].n,
      1,
    );
    await f.market.openPaymentDispute(
      B.C,
      "agreement",
      B.g.id,
      {
        expectedPaymentRevision: (await f.market.agreementFunding(B.C, B.g.id))
          .paymentRevision,
        reason: "New independent hold after original approval",
      },
      key(),
    );
    await worker.dispatch();
    assert.equal(t.refunds.size, 0);
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund'",
          [B.q.obligationId],
        )
      ).rows[0].status,
      "held",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT status FROM campus.money_reservations r JOIN campus.funding_lots l ON l.id=r.lot_id WHERE l.obligation_id=$1 AND r.kind='refund'",
          [B.q.obligationId],
        )
      ).rows[0].status,
      "reserved",
    );
  } finally {
    await f.close();
  }
});
