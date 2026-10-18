import test from "node:test";
import assert from "node:assert/strict";
import {
  isolated,
  key,
  syntheticPolicyPayload,
  snapshotExistingTables,
  journal,
} from "./payment-money-fixture.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
import { createPosting } from "../../backend/payments/posting.mjs";
import { agreement, fakeTransport } from "./payment-money-scenarios.mjs";
test("real services and SQL J1-J5, signed terms, fee consumption, team component transfers; mock provider transport only", async () => {
  const f = await isolated();
  try {
    await f.migrateThrough(18);
    const setup = await agreement(f, { team: true });
    const before = (
      await f.owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
        setup.g.id,
      ])
    ).rows[0].terms;
    const priorTables = await snapshotExistingTables(f.owner);
    await f.migrateThrough(20);
    assert.deepEqual(
      await snapshotExistingTables(
        f.owner,
        priorTables.map((t) => t.table),
      ),
      priorTables,
    );
    await journal({
      action: "preupgrade_table_preservation",
      database: f.database,
      tableCount: priorTables.length,
      nonemptyTables: priorTables.filter((t) => t.count > 0).length,
      tables: priorTables,
    });
    assert.deepEqual(
      (
        await f.owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
          setup.g.id,
        ])
      ).rows[0].terms,
      before,
    );
    await f.store.verifyRoles();
    const env = {
      id: key(),
      platformAccountId: "acct_synthetic",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B isolated synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const payload = {
      signedPolicyId: setup.pol,
      feeAdjustment: "hold_on_variance",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_execution_policies(environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,'agreement',$2,'collection',1,'approved',$3,$4,'Task2B mock/fault-injection only')",
      [env.id, setup.g.id, JSON.stringify(payload), digest(payload)],
    );
    const payerEntry = await f.market.agreementFunding(setup.P, setup.g.id),
      payeeEntry = await f.market.agreementFunding(setup.C, setup.g.id);
    assert.equal(payerEntry.coverage, "unknown");
    assert.ok(payerEntry.allowedActions.includes("request_quote"));
    assert.ok(!payeeEntry.allowedActions.includes("request_quote"));
    assert.ok(
      payeeEntry.blockedReasons.includes(
        "recipient_identity_configuration_required",
      ),
    );
    const detail = await f.market.agreement(setup.P, setup.g.id),
      binding = detail.transaction.bindings[0],
      tt = detail.transaction.terms[0];
    const q = (
      await f.market.createAgreementPaymentQuote(
        setup.P,
        setup.g.id,
        {
          expectedEffectiveTermsId: binding.terms_id,
          expectedEffectiveRevision: binding.terms_revision,
          transactionTermsId: tt.id,
          transactionTermsRevision: tt.revision,
        },
        key(),
      )
    ).receipt;
    assert.ok(
      (
        await f.market.agreementFunding(setup.P, setup.g.id)
      ).allowedActions.includes("create_payment_attempt"),
    );
    assert.ok(
      !(
        await f.market.agreementFunding(setup.C, setup.g.id)
      ).allowedActions.includes("create_payment_attempt"),
    );
    const request = {
      quoteId: q.quoteId,
      quoteDigest: q.quoteDigest,
      expectedObligationRevision: q.obligationRevision,
      acceptedAmountCents: 10151,
      currency: "USD",
    };
    const [one, two] = await Promise.all([
      f.market.createPaymentAttempt(setup.P, q.obligationId, request, key()),
      f.market.createPaymentAttempt(setup.P, q.obligationId, request, key()),
    ]);
    assert.equal(one.receipt.attemptId, two.receipt.attemptId);
    const transport = fakeTransport(),
      adapter = createStripePayments({
        client: transport.client,
        environment: env,
      }),
      worker = createPaymentWorker(f.store, adapter);
    await worker.dispatch();
    const a = await f.market.paymentAttempt(setup.P, one.receipt.attemptId);
    assert.equal(a.status, "requires_action");
    assert.ok(a.hostedUrl);
    assert.equal(
      (await f.market.paymentAttempt(setup.C, a.attemptId)).hostedUrl,
      null,
    );
    assert.ok(
      (
        await f.market.agreementFunding(setup.P, setup.g.id)
      ).allowedActions.includes("open_checkout"),
    );
    assert.ok(
      !(
        await f.market.agreementFunding(setup.C, setup.g.id)
      ).allowedActions.includes("open_checkout"),
    );
    transport.pay(a.sessionId);
    const expected = (
      await f.store.workerTx((c) =>
        c.query("SELECT campus.money_find_attempt($1,$2) AS result", [
          env.id,
          a.sessionId,
        ]),
      )
    ).rows[0].result;
    const post = createPosting(f.store);
    await post.payment(
      expected,
      await adapter.retrieveCheckoutAndPayment(a.sessionId),
    );
    await post.payment(
      expected,
      await adapter.retrieveCheckoutAndPayment(a.sessionId),
    );
    const receiptFacts = (
      await f.owner.query(
        "SELECT * FROM campus.payment_receipt_facts WHERE obligation_id=$1",
        [q.obligationId],
      )
    ).rows;
    assert.equal(receiptFacts.length, 1);
    assert.equal(receiptFacts[0].attempt_id, a.attemptId);
    assert.ok(receiptFacts[0].receipt_journal_id);
    assert.ok(receiptFacts[0].fee_journal_id);
    assert.ok(receiptFacts[0].fee_recovery_journal_id);
    assert.equal(receiptFacts[0].disposition, "allocated");
    assert.equal(receiptFacts[0].fee_zero_omitted, false);
    await assert.rejects(
      f.owner.query(
        "UPDATE campus.payment_receipt_facts SET observed_fee_cents=0",
      ),
      (e) => e.code === "23514",
    );
    assert.equal(
      (await f.market.agreement(setup.P, setup.g.id)).state,
      "active",
    );
    const gd = await f.market.agreement(setup.C, setup.g.id);
    const ms = gd.milestones[0];
    const submitted = await f.market.submitMilestone(
      setup.C,
      ms.id,
      {
        expectedVersion: ms.version,
        expectedRevision: ms.revision,
        content: "Synthetic completed work",
        expectedEffectiveTermsId: binding.terms_id,
        expectedEffectiveRevision: binding.terms_revision,
      },
      key(),
    );
    const fresh = await f.market.agreement(setup.P, setup.g.id);
    const sm = fresh.milestones[0];
    await f.market.acceptMilestone(
      setup.P,
      sm.id,
      {
        submissionId: sm.latest_submission_id,
        expectedVersion: sm.version,
        expectedRevision: sm.revision,
        submissionTermsId: binding.terms_id,
        submissionTermsRevision: binding.terms_revision,
        transactionTermsId: tt.id,
        transactionTermsRevision: tt.revision,
      },
      key(),
    );
    for (const user of setup.members) {
      const config = {
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { requested: true } },
            },
          },
        },
      };
      await f.owner.query(
        "INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B authorized synthetic identity configuration; no provider call')",
        [env.id, user, JSON.stringify(config), digest(config)],
      );
      assert.ok(
        (
          await f.market.agreementFunding(user, setup.g.id)
        ).allowedActions.includes("open_onboarding"),
      );
      await f.market.onboardPaymentAccount(
        user,
        { expectedAccountRevision: 0 },
        key(),
      );
      await worker.dispatch();
    }
    await worker.refreshRecipients();
    await worker.tick();
    await worker.tick();
    assert.equal(transport.transfers.size, 2);
    assert.deepEqual(
      [...transport.transfers.values()]
        .map((x) => x.amount)
        .sort((a, b) => a - b),
      [3940, 5910],
    );
    const released = await f.market.agreementFunding(setup.P, setup.g.id);
    assert.ok(
      released.payees.every(
        (p) => p.releaseState === "transferred" && p.bankPayout === "unknown",
      ),
    );
    assert.ok(released.allowedActions.includes("request_refund_review"));
    assert.ok(
      !(
        await f.market.agreementFunding(setup.C, setup.g.id)
      ).allowedActions.includes("request_refund_review"),
    );
    const balances = (
      await f.owner.query(
        "SELECT account,sum(debit-credit)::text AS balance FROM campus.ledger_lines GROUP BY account ORDER BY account",
      )
    ).rows;
    assert.equal(balances.find((x) => x.account === "cash").balance, "0");
    assert.equal(
      balances.find((x) => x.account === "reward_liability").balance,
      "0",
    );
    assert.equal(
      balances.find((x) => x.account === "publisher_fee_liability").balance,
      "0",
    );
    assert.equal(balances.find((x) => x.account === "payable").balance, "0");
    assert.equal(
      (
        await f.owner.query(
          "SELECT sum(gross_satisfied_cents)::text AS n FROM campus.payables",
        )
      ).rows[0].n,
      "10000",
    );
    await assert.rejects(
      f.store.as(setup.P, (c) =>
        c.query(
          "INSERT INTO campus.ledger_journals(environment_id,source_effect,currency) VALUES($1,'forge','USD')",
          [env.id],
        ),
      ),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      f.owner.query("UPDATE campus.ledger_lines SET debit=1"),
      (e) => e.code === "23514",
    );
    assert.equal(
      (await f.market.agreementFunding(setup.P, setup.g.id)).coverage,
      "covered",
    );
    // A second authenticated receipt is suspense, never a second fulfillment payment.
    transport.pay(a.sessionId);
    await post.payment(
      expected,
      await adapter.retrieveCheckoutAndPayment(a.sessionId),
    );
    const extra = await adapter.retrieveCheckoutAndPayment(a.sessionId),
      newFeeId = "txn_" + key();
    extra.charge.balance_transaction = newFeeId;
    transport.balances.set(newFeeId, { ...extra.balance, id: newFeeId });
    for (let i = 0; i < 2; i++)
      await post.payment(
        expected,
        await adapter.retrieveCheckoutAndPayment(a.sessionId),
      );
    transport.setFee(a.sessionId, 777);
    for (let i = 0; i < 2; i++)
      await post.payment(
        expected,
        await adapter.retrieveCheckoutAndPayment(a.sessionId),
      );
    assert.equal(
      (
        await f.owner.query(
          "SELECT sum(debit-credit)::text n FROM campus.ledger_lines WHERE account='cash'",
        )
      ).rows[0].n,
      "9850",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_receipt_facts WHERE disposition='fee_conflict'",
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (await f.market.agreementFunding(setup.P, setup.g.id)).coverage,
      "held",
    );
  } finally {
    await f.close();
  }
});
