import { key, syntheticPolicyPayload } from "./payment-money-fixture.mjs";
export async function agreement(
  f,
  { mode = "per_milestone", fee = 301, stages = [10000], team = false } = {},
) {
  const m = f.market,
    P = await f.user("Publisher"),
    C = await f.user("Recipient"),
    M = team ? await f.user("Member") : null;
  let tid = null;
  if (team) {
    const t = await m.createTeam(
      C,
      {
        name: "Money Team",
        context: {
          purpose: "Research",
          activities: "Read sources",
          timeCommitment: "One hour",
          projectContext: "",
        },
      },
      key(),
    );
    await m.inviteMember(
      C,
      t.id,
      { userId: M, expectedRevision: t.revision },
      key(),
    );
    await m.acceptMembership(
      M,
      t.id,
      { expectedRevision: (await m.team(M, t.id)).revision },
      key(),
    );
    tid = t.id;
  }
  const t = await m.publishTask(
    P,
    {
      title: "Money integration synthetic",
      category: "Research",
      description: "Isolated synthetic fixture",
      rewardCents: stages.reduce((s, n) => s + n, 0),
      dueDate: "2027-01-01",
      releasePolicy: mode,
      milestones: stages.map((v, i) => ({
        title: "Stage " + (i + 1),
        amountCents: v,
        deliverable: "Report " + (i + 1),
      })),
    },
    key(),
  );
  const a = (
    await m.applyVersioned(
      C,
      t.id,
      {
        proposal: "Exact work",
        teamId: tid,
        expectedTermsVersion: 1,
        expectedRevision: 1,
      },
      key(),
    )
  ).receipt.id;
  const members = M ? [C, M] : [C];
  for (const actor of members)
    await m.acknowledgeApplicationTerms(
      actor,
      a,
      { expectedTermsVersion: 1, expectedRevision: 1 },
      key(),
    );
  const pol = key();
  await f.owner.query(
    "INSERT INTO campus.payment_policy_versions(id,application_id,listing_version,status,provenance,payload) VALUES($1,$2,1,'approved','Task2B synthetic only',$3)",
    [
      pol,
      a,
      JSON.stringify(
        syntheticPolicyPayload(
          fee,
          stages.reduce((s, n) => s + n, 0),
        ),
      ),
    ],
  );
  const alloc = await m.proposeAllocation(
    C,
    a,
    {
      expectedTermsVersion: 1,
      expectedRevision: 1,
      expectedAllocationRevision: 0,
      ratios: members.map((id, i) => ({
        userId: id,
        ratioUnits: M ? (i ? 4000 : 6000) : 10000,
      })),
      ratioDenominator: 10000,
      policyVersionId: pol,
    },
    key(),
  );
  for (const actor of [P, ...members])
    await m.confirmAllocation(
      actor,
      a,
      1,
      {
        expectedTermsVersion: 1,
        expectedRevision: 1,
        allocationDigest: alloc.current.current.digest,
      },
      key(),
    );
  await m.inviteApplicationVersion(
    P,
    a,
    { expectedTermsVersion: 1, expectedRevision: 1 },
    key(),
  );
  const g = (
    await m.acceptApplicationVersion(
      C,
      a,
      { expectedTermsVersion: 1, expectedRevision: 1 },
      key(),
    )
  ).agreement;
  return { P, C, M, g, pol, members };
}
export function fakeTransport({now=Date.now}={}) {
  const ids = new Map(),
    sessions = new Map(),
    intents = new Map(),
    charges = new Map(),
    balances = new Map(),
    transfers = new Map(),
    reversals = new Map(),
    refunds = new Map(),
    refundKeys = new Map();
  const transferKeys=new Map(),reversalKeys=new Map(),linkKeys=new Map(),links=new Map(),calls=[];
  let last,
    transferStatus = "active";
  return {
    sessions,links,calls,
    transfers,
    balances,
    refunds,
    reversals,
    failRefund(id, { available = true } = {}) {
      const r = refunds.get(id),
        bid = r.failure_balance_transaction ?? "txn_" + key();
      r.status = "failed";
      r.failure_balance_transaction = bid;
      balances.set(bid, {
        id: bid,
        source: id,
        amount: r.amount,
        fee: 0,
        net: r.amount,
        currency: "usd",
        status: available ? "available" : "pending",
      });
    },
    setCapability(value) {
      transferStatus = value;
    },
    setFee(sessionId, fee) {
      const c = charges.get(
        intents.get(sessions.get(sessionId).payment_intent).latest_charge,
      );
      const bt = c.balance_transaction ?? "txn_" + key();
      c.balance_transaction = bt;
      balances.set(bt, {
        id: bt,
        source: c.id,
        amount: c.amount,
        fee,
        net: c.amount - fee,
        currency: "usd",
        status: "available",
      });
    },
    pay(sessionId, { fee = 301, available = true } = {}) {
      const s = sessions.get(sessionId),
        pi = "pi_" + key(),
        ch = "ch_" + key(),
        bt = "txn_" + key();
      s.payment_intent = pi;
      s.payment_status = "paid";
      s.status = "complete";
      intents.set(pi, {
        id: pi,
        status: "succeeded",
        amount: s.amount_total,
        amount_received: s.amount_total,
        currency: "usd",
        livemode: false,
        metadata: {
          attemptId: s.client_reference_id,
          obligationId: s.metadata.obligationId,
          sourceDigest: s.metadata.sourceDigest,
        },
        latest_charge: ch,
      });
      charges.set(ch, {
        id: ch,
        payment_intent: pi,
        amount: s.amount_total,
        amount_captured: s.amount_total,
        currency: "usd",
        paid: true,
        captured: true,
        livemode: false,
        balance_transaction: fee === null ? null : bt,
      });
      if (fee !== null)
        balances.set(bt, {
          id: bt,
          source: ch,
          amount: s.amount_total,
          fee,
          net: s.amount_total - fee,
          currency: "usd",
          status: available ? "available" : "pending",
        });
    },
    client: {
      v2: {
        core: {
          accountLinks:{async create(p,opts){calls.push({kind:'onboarding',key:opts.idempotencyKey,p:structuredClone(p)});if(linkKeys.has(opts.idempotencyKey))return links.get(linkKeys.get(opts.idempotencyKey));const url='https://connect.stripe.com/setup/synthetic_'+key();const link={object:'v2.core.account_link',account:p.account,livemode:false,url,created:new Date(now()).toISOString(),expires_at:new Date(now()+300000).toISOString()};links.set(url,link);linkKeys.set(opts.idempotencyKey,url);return link;}},
          accounts: {
            async create() {
              return { id: "acct_" + key().replaceAll("-", "") };
            },
            async retrieve(id) {
              return {
                id,
                configuration: {
                  recipient: {
                    capabilities: {
                      stripe_balance: {
                        stripe_transfers: { status: transferStatus },
                        payouts: { status: "unknown" },
                      },
                    },
                  },
                },
              };
            },
          },
        },
      },
      checkout: {
        sessions: {
          async create(p, opts) {
            last = { p, opts };calls.push({kind:'checkout',key:opts.idempotencyKey,p:structuredClone(p)});
            if(p.expires_at!==undefined && (p.expires_at<now()/1000+1800||p.expires_at>now()/1000+86400))throw Object.assign(Error('invalid_expiry'),{type:'StripeInvalidRequestError',code:'parameter_invalid_integer',statusCode:400});
            if (ids.has(opts.idempotencyKey))
              return sessions.get(ids.get(opts.idempotencyKey));
            const sid = "cs_" + key();
            const s = {
              id: sid,
              mode: "payment",
              amount_total: p.line_items[0].price_data.unit_amount,
              currency: "usd",
              livemode: false,
              client_reference_id: p.client_reference_id,
              metadata: p.metadata,
              payment_status: "unpaid",
              status: "open",
              payment_intent: null,
              url: "https://checkout.stripe.com/c/pay/synthetic",
              expires_at: p.expires_at??Math.floor(now()/1000)+86400,
            };
            sessions.set(sid, s);
            ids.set(opts.idempotencyKey, sid);
            return s;
          },
          async retrieve(id) {
            return sessions.get(id);
          },
          async expire(id) {
            const s = sessions.get(id);
            if(s.status!=='open')throw Object.assign(Error('session_not_open'),{type:'StripeInvalidRequestError',code:'checkout_session_not_open',statusCode:400});
            s.status='expired';return s;
          },
        },
      },
      paymentIntents: {
        async retrieve(id) {
          return intents.get(id);
        },
      },
      charges: {
        async retrieve(id) {
          return charges.get(id);
        },
      },
      reporting:{reportRuns:{async list(){return {data:[],has_more:false};}}},
      balanceTransactions: {
        async list({starting_after,limit=16}={}){const all=[...balances.values()].filter(b=>b.type==='stripe_fee'),offset=starting_after?all.findIndex(b=>b.id===starting_after)+1:0;return {data:all.slice(offset,offset+limit),has_more:offset+limit<all.length};},
        async retrieve(id) {
          return balances.get(id);
        },
      },
      refunds: {
        async retrieve(id) {
          return refunds.get(id);
        },
        async create(p, opts) {
          calls.push({kind:'refund',key:opts?.idempotencyKey,p:structuredClone(p)});
          if (opts?.idempotencyKey && refundKeys.has(opts.idempotencyKey))
            return refunds.get(refundKeys.get(opts.idempotencyKey));
          const id = "re_" + key(),
            bid = "txn_" + key();
          balances.set(bid, {
            id: bid,
            source: id,
            amount: -p.amount,
            fee: 0,
            net: -p.amount,
            currency: "usd",
            status: "available",
          });
          const r = {
            ...p,
            id,
            currency: "usd",
            status: "succeeded",
            balance_transaction: bid,
          };
          refunds.set(id, r);
          if (opts?.idempotencyKey) refundKeys.set(opts.idempotencyKey, id);
          return r;
        },
      },
      transfers: {
        async retrieve(id) {
          return transfers.get(id);
        },
        async retrieveReversal(tid, id) {
          return reversals.get(id);
        },
        async listReversals(tid) {
          return {
            data: [...reversals.values()].filter((r) => r.transfer === tid),
            has_more: false,
          };
        },
        async createReversal(transfer, p,opts={}) {
          calls.push({kind:'reversal',key:opts.idempotencyKey,p:structuredClone(p)});if(reversalKeys.has(opts.idempotencyKey))return reversals.get(reversalKeys.get(opts.idempotencyKey));
          const id = "trr_" + key(),
            bid = "txn_" + key();
          balances.set(bid, {
            id: bid,
            source: id,
            amount: p.amount,
            fee: 0,
            net: p.amount,
            currency: "usd",
            status: "available",
          });
          const r = {
            ...p,
            id,
            transfer,
            currency: "usd",
            balance_transaction: bid,
          };
          reversals.set(id, r);reversalKeys.set(opts.idempotencyKey,id);
          return r;
        },
        async create(p,opts={}) {
          calls.push({kind:'transfer',key:opts.idempotencyKey,p:structuredClone(p)});if(transferKeys.has(opts.idempotencyKey))return transfers.get(transferKeys.get(opts.idempotencyKey));
          const t = { ...p, id: "tr_" + key(), livemode: false };
          transfers.set(t.id, t);transferKeys.set(opts.idempotencyKey,t.id);
          return t;
        },
      },
    },
  };
}

export async function fundedAgreement(
  f,
  env,
  worker,
  adapter,
  transport,
  post,
  opts = {},
) {
  const s = await agreement(f, opts),
    payload = { signedPolicyId: s.pol, feeAdjustment: "hold_on_variance" };
  const { digest } = await import("../../backend/payments/amounts.mjs");
  const policyId = key();
  await f.owner.query(
    "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',1,'approved',$4,$5,'Task2B isolated synthetic collection')",
    [policyId, env.id, s.g.id, JSON.stringify(payload), digest(payload)],
  );
  const gd = await f.market.agreement(s.P, s.g.id),
    b = gd.transaction.bindings[0],
    tt = gd.transaction.terms[0];
  const q = (
    await f.market.createAgreementPaymentQuote(
      s.P,
      s.g.id,
      {
        expectedEffectiveTermsId: b.terms_id,
        expectedEffectiveRevision: b.terms_revision,
        transactionTermsId: tt.id,
        transactionTermsRevision: tt.revision,
      },
      key(),
    )
  ).receipt;
  const attempt = (
    await f.market.createPaymentAttempt(
      s.P,
      q.obligationId,
      {
        quoteId: q.quoteId,
        quoteDigest: q.quoteDigest,
        expectedObligationRevision: q.obligationRevision,
        acceptedAmountCents: q.quote.chargeTotalCents,
        currency: "USD",
      },
      key(),
    )
  ).receipt;
  await worker.dispatch();
  const a = await f.market.paymentAttempt(s.P, attempt.attemptId);
  const expected = (
    await f.store.workerTx((c) =>
      c.query("SELECT campus.money_find_attempt($1,$2) AS result", [
        env.id,
        a.sessionId,
      ]),
    )
  ).rows[0].result;
  transport.pay(a.sessionId, {
    fee: opts.fee ?? 301,
    available: opts.available ?? true,
  });
  const objects = await adapter.retrieveCheckoutAndPayment(a.sessionId);
  await post.payment(expected, objects);
  return { ...s, q, b, tt, policyId, charge: objects.charge };
}
export async function earnAndOnboard(f, s, env, worker) {
  const config = {
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: { stripe_transfers: { requested: true } },
        },
      },
    },
  };
  for (const user of s.members) {
    await f.owner.query(
      "INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B synthetic recipient configuration')",
      [
        env.id,
        user,
        JSON.stringify(config),
        (await import("../../backend/payments/amounts.mjs")).digest(config),
      ],
    );
    await f.market.onboardPaymentAccount(
      user,
      { expectedAccountRevision: 0 },
      key(),
    );
    await worker.dispatch();
  }
  await worker.refreshRecipients();
  let gd = await f.market.agreement(s.C, s.g.id),
    m = gd.milestones[0];
  await f.market.submitMilestone(
    s.C,
    m.id,
    {
      expectedVersion: m.version,
      expectedRevision: m.revision,
      content: "Exact completed work",
      expectedEffectiveTermsId: s.b.terms_id,
      expectedEffectiveRevision: s.b.terms_revision,
    },
    key(),
  );
  gd = await f.market.agreement(s.P, s.g.id);
  m = gd.milestones[0];
  await f.market.acceptMilestone(
    s.P,
    m.id,
    {
      submissionId: m.latest_submission_id,
      expectedVersion: m.version,
      expectedRevision: m.revision,
      submissionTermsId: s.b.terms_id,
      submissionTermsRevision: s.b.terms_revision,
      transactionTermsId: s.tt.id,
      transactionTermsRevision: s.tt.revision,
    },
    key(),
  );
}
