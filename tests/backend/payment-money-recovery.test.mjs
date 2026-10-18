import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./payment-money-fixture.mjs";
import { agreement, fakeTransport } from "./payment-money-scenarios.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
import { createPosting } from "../../backend/payments/posting.mjs";
test("actual final group, fee pending/variance, exact-object mismatch and unknown create recovery; mock/fault injection", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(20);
    const env = {
      id: key(),
      platformAccountId: "acct_recovery",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B recovery synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const transport = fakeTransport(),
      adapter = createStripePayments({
        client: transport.client,
        environment: env,
      }),
      worker = createPaymentWorker(f.store, adapter),
      post = createPosting(f.store);
    async function prepare(opts = {}) {
      const setup = await agreement(f, opts);
      const payload = {
        signedPolicyId: setup.pol,
        feeAdjustment: "hold_on_variance",
      };
      await f.owner.query(
        "INSERT INTO campus.payment_execution_policies(environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,'agreement',$2,'collection',1,'approved',$3,$4,'Task2B isolated scenario')",
        [env.id, setup.g.id, JSON.stringify(payload), digest(payload)],
      );
      const gd = await f.market.agreement(setup.P, setup.g.id),
        b = gd.transaction.bindings[0],
        tt = gd.transaction.terms[0];
      const q = (
        await f.market.createAgreementPaymentQuote(
          setup.P,
          setup.g.id,
          {
            expectedEffectiveTermsId: b.terms_id,
            expectedEffectiveRevision: b.terms_revision,
            transactionTermsId: tt.id,
            transactionTermsRevision: tt.revision,
          },
          key(),
        )
      ).receipt;
      const req = {
        quoteId: q.quoteId,
        quoteDigest: q.quoteDigest,
        expectedObligationRevision: q.obligationRevision,
        acceptedAmountCents: q.quote.chargeTotalCents,
        currency: "USD",
      };
      const a = (
        await f.market.createPaymentAttempt(setup.P, q.obligationId, req, key())
      ).receipt;
      return { ...setup, b, tt, q, req, a };
    }
    async function expected(s) {
      const a = await f.market.paymentAttempt(s.P, s.a.attemptId);
      return (
        await f.store.workerTx((c) =>
          c.query("SELECT campus.money_find_attempt($1,$2) AS result", [
            env.id,
            a.sessionId,
          ]),
        )
      ).rows[0].result;
    }
    async function accept(s, index) {
      let gd = await f.market.agreement(s.C, s.g.id),
        m = gd.milestones[index];
      await f.market.submitMilestone(
        s.C,
        m.id,
        {
          expectedVersion: m.version,
          expectedRevision: m.revision,
          content: "Completed exact work",
          expectedEffectiveTermsId: s.b.terms_id,
          expectedEffectiveRevision: s.b.terms_revision,
        },
        key(),
      );
      gd = await f.market.agreement(s.P, s.g.id);
      m = gd.milestones[index];
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
    const final = await prepare({
      team: true,
      mode: "final_completion",
      fee: 600,
      stages: [10000, 10000],
    });
    await worker.dispatch();
    let ex = await expected(final);
    transport.pay(ex.sessionId, { fee: 600 });
    await post.payment(
      ex,
      await adapter.retrieveCheckoutAndPayment(ex.sessionId),
    );
    for (const user of final.members) {
      const conf = {
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { requested: true } },
            },
          },
        },
      };
      await f.owner.query(
        "INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B synthetic recipient configuration')",
        [env.id, user, JSON.stringify(conf), digest(conf)],
      );
      await f.market.onboardPaymentAccount(
        user,
        { expectedAccountRevision: 0 },
        key(),
      );
      await worker.dispatch();
    }
    await worker.refreshRecipients();
    await accept(final, 0);
    await worker.tick();
    assert.equal(transport.transfers.size, 0);
    await accept(final, 1);
    for (let i = 0; i < 4; i++) await worker.tick();
    assert.equal(transport.transfers.size, 4);
    assert.equal(
      [...transport.transfers.values()].reduce((n, t) => n + t.amount, 0),
      19700,
    );
    const pending = await prepare();
    await worker.dispatch();
    ex = await expected(pending);
    transport.pay(ex.sessionId, { fee: null });
    await post.payment(
      ex,
      await adapter.retrieveCheckoutAndPayment(ex.sessionId),
    );
    await accept(pending, 0);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int AS n FROM campus.payables p JOIN campus.funding_lots l ON l.id=p.lot_id WHERE l.obligation_id=$1",
          [pending.q.obligationId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await f.market.agreementFunding(pending.P, pending.g.id)).feeState,
      "fee_actual_pending",
    );
    transport.setFee(ex.sessionId, 303);
    await post.payment(
      ex,
      await adapter.retrieveCheckoutAndPayment(ex.sessionId),
    );
    assert.equal(
      (await f.market.agreementFunding(pending.P, pending.g.id)).coverage,
      "held",
    );
    const heldRead = await f.market.agreementFunding(pending.P, pending.g.id);
    assert.equal(heldRead.heldCents, "9848");
    assert.ok(!heldRead.allowedActions.includes("open_checkout"));
    assert.ok(!heldRead.allowedActions.includes("request_quote"));
    assert.ok(heldRead.allowedActions.includes("request_refund_review"));
    assert.ok(heldRead.allowedActions.includes("open_dispute"));
    assert.ok(heldRead.payees.every((p) => p.releaseState === "held"));
    const acct = (
      await f.owner.query(
        "SELECT ll.account,sum(ll.debit-ll.credit)::text AS n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id JOIN campus.funding_lots l ON l.id=j.lot_id WHERE l.obligation_id=$1 GROUP BY ll.account",
        [pending.q.obligationId],
      )
    ).rows;
    assert.equal(acct.find((r) => r.account === "cash").n, "9848");
    assert.equal(
      acct.find((r) => r.account === "reward_liability").n,
      "-10000",
    );
    assert.equal(
      acct.find((r) => r.account === "publisher_fee_liability").n,
      "-151",
    );
    assert.ok(!acct.some((r) => r.account === "fee_recovery"));
    const zero = await prepare({ fee: 0 });
    await worker.dispatch();
    const zeroEx = await expected(zero);
    transport.pay(zeroEx.sessionId, { fee: 0 });
    await post.payment(
      zeroEx,
      await adapter.retrieveCheckoutAndPayment(zeroEx.sessionId),
    );
    const zeroFact = (
      await f.owner.query(
        "SELECT * FROM campus.payment_receipt_facts WHERE obligation_id=$1",
        [zero.q.obligationId],
      )
    ).rows[0];
    assert.equal(zeroFact.fee_zero_omitted, true);
    assert.equal(zeroFact.recovery_zero_omitted, true);
    assert.equal(zeroFact.fee_journal_id, null);
    assert.equal(zeroFact.fee_recovery_journal_id, null);
    assert.ok(zeroFact.receipt_journal_id);
    const mismatch = await prepare();
    await worker.dispatch();
    ex = await expected(mismatch);
    transport.pay(ex.sessionId);
    const objects = await adapter.retrieveCheckoutAndPayment(ex.sessionId);
    for (const mutate of [
      (v) => (v.session.currency = "eur"),
      (v) => v.intent.amount_received++,
      (v) => (v.charge.payment_intent = "pi_unrelated"),
      (v) => (v.session.livemode = true),
      (v) => (v.session.metadata.sourceDigest = "foreign"),
    ]) {
      const copied = structuredClone(objects);
      mutate(copied);
      await assert.rejects(
        post.payment(ex, copied),
        (e) => e.code === "provider_fact_mismatch",
      );
    }
    assert.equal(
      (await f.market.agreement(mismatch.P, mismatch.g.id)).state,
      "awaiting_funding",
    );
    const unknown = await prepare();
    const original = adapter.createCheckout;
    let once = true;
    adapter.createCheckout = async (op) => {
      const r = await original(op);
      if (once) {
        once = false;
        throw Error("synthetic response lost after provider create");
      }
      return r;
    };
    await worker.dispatch();
    assert.equal(
      (await f.market.paymentAttempt(unknown.P, unknown.a.attemptId)).status,
      "unknown",
    );
    const unknownRead = await f.market.agreementFunding(
      unknown.P,
      unknown.g.id,
    );
    assert.ok(unknownRead.allowedActions.includes("refresh_attempt"));
    assert.ok(!unknownRead.allowedActions.includes("create_payment_attempt"));
    assert.ok(!unknownRead.allowedActions.includes("open_checkout"));
    const retry = await f.market.createPaymentAttempt(
      unknown.P,
      unknown.q.obligationId,
      unknown.req,
      key(),
    );
    assert.equal(retry.receipt.attemptId, unknown.a.attemptId);
    await new Promise((r) => setTimeout(r, 2100));
    await worker.dispatch();
    assert.equal(
      (await f.market.paymentAttempt(unknown.P, unknown.a.attemptId)).status,
      "requires_action",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int AS n FROM campus.money_operations WHERE obligation_id=$1",
          [unknown.q.obligationId],
        )
      ).rows[0].n,
      1,
    );
    const countEffects = async () =>
      (
        await f.owner.query(
          "SELECT count(*)::int AS n FROM campus.money_effect_history WHERE aggregate_id=$1 AND relation_name='connected_payee_accounts'",
          [final.g.id],
        )
      ).rows[0].n;
    const beforeRefresh = await countEffects();
    await worker.refreshRecipients();
    await worker.refreshRecipients();
    assert.equal(await countEffects(), beforeRefresh);
    transport.setCapability("restricted");
    await worker.refreshRecipients();
    transport.setCapability("active");
    await worker.refreshRecipients();
    assert.equal(await countEffects(), beforeRefresh + 4);
    const history = (
      await f.owner.query(
        "SELECT count(*)::int AS n,max(revision)::int AS last FROM campus.money_effect_history WHERE aggregate_id=$1",
        [final.g.id],
      )
    ).rows[0];
    assert.ok(history.n > 20);
    assert.equal(history.n, history.last);
    await assert.rejects(
      f.owner.query("DELETE FROM campus.money_effect_history"),
      (e) => e.code === "23514",
    );
  } finally {
    await f.close();
  }
});
