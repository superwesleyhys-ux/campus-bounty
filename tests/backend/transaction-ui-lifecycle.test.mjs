import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./transaction-ui-fixture.mjs";
import { configure } from "./transaction-ui-setup.mjs";
import {
  agreement,
  quoteAgreement,
  pay,
  onboard,
  acceptStage,
  candidate,
  sign,
} from "./transaction-ui-journeys.mjs";

test("ordinary prepared funded amendment and exact original/new team settlement for both release choices", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f);
    for (const mode of ["per_milestone", "final_completion"]) {
      const s = await pay(
        f,
        x,
        await quoteAgreement(
          f,
          await agreement(f, { team: true, mode, stages: [5000, 5000] }),
        ),
      );
      for (const who of s.members) await onboard(f, x, who);
      await acceptStage(f, s, 0);
      for (let i = 0; i < 6; i++) await x.worker.tick();
      let view = await f.market.agreementFunding(s.P, s.g.id);
      for (const [id, amount] of [
        [s.C, 2985],
        [s.M, 1990],
      ])
        assert.equal(
          view.payees
            .filter((p) => p.memberId === id)
            .reduce((n, p) => n + Number(p.transferredCents), 0),
          mode === "per_milestone" ? amount : 0,
        );
      const oldIds = view.payees.map((p) => p.componentId).sort();
      const c = await candidate(f, x, s);
      await sign(f, s, c);
      const q = (
        await f.market.quoteAmendmentFinancialPlan(
          s.P,
          s.g.id,
          c.aid,
          c.p.revision,
          { ...c.exact, digest: c.p.digest },
          key(),
        )
      ).receipt;
      const added = await pay(f, x, {
        ...s,
        q,
        attemptRequest: {
          quoteId: q.quoteId,
          quoteDigest: q.quoteDigest,
          expectedObligationRevision: q.obligationRevision,
          acceptedAmountCents: q.amountCents,
          currency: "USD",
        },
      });
      const act = await f.market.activateAmendmentFinancialPlan(
        s.P,
        s.g.id,
        c.aid,
        c.p.revision,
        { ...c.exact, digest: c.p.digest },
        key(),
      );
      assert.equal(act.receipt.status, "effective");
      const current = await f.market.amendmentFinancialPlans(
        s.P,
        s.g.id,
        c.aid,
      );
      assert.equal(current.effectiveMembership.components.length, 6);
      assert.deepEqual(
        current.effectiveMembership.components
          .filter((p) => p.origin === "application")
          .map((p) => p.componentId)
          .sort(),
        oldIds,
      );
      await acceptStage(f, s, 1);
      await acceptStage(f, s, 2);
      for (let i = 0; i < 16; i++) await x.worker.tick();
      view = await f.market.agreementFunding(s.P, s.g.id);
      const amended = (
        await f.market.amendmentFinancialPlans(s.P, s.g.id, c.aid)
      ).effectiveMembership;
      const accounts = (
        await f.owner.query(
          "SELECT user_id,provider_account_id FROM campus.connected_payee_accounts WHERE environment_id=$1",
          [x.env.id],
        )
      ).rows;
      for (const [who, amount] of [
        [s.C, 6540],
        [s.M, 4360],
      ]) {
        const aid = accounts.find((a) => a.user_id === who).provider_account_id;
        assert.equal(
          [...x.transport.transfers.values()]
            .filter((t) => t.destination === aid)
            .reduce((n, t) => n + t.amount, 0),
          amount,
        );
      }
      assert.equal(amended.components.length, 6);
    }
  } finally {
    await f.close();
  }
});

test("new ordinary goods order has personal terms, payment, fulfillment, receipt and seller transfer", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f),
      P = await f.user("Buyer"),
      C = await f.user("Seller");
    const product = await f.market.publishProduct(
      C,
      {
        title: "Synthetic book",
        description: "Local test physical book",
        priceCents: 10000,
        stock: 2,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      key(),
    );
    const reservation = await f.market.quoteVersioned(
      P,
      product.id,
      {
        quantity: 1,
        deliveryMethod: "pickup",
        expectedRevision: 1,
        expectedTermsVersion: 1,
      },
      key(),
    );
    const order = await f.market.order(P, { quoteId: reservation.id }, key());
    await f.market.preparePaymentTerms(P, "order", order.id, {}, key());
    let v = await f.market.participantPayment(P, "order", order.id);
    const p = v.orderPolicy;
    for (const who of [P, C])
      await f.market.confirmOrderPaymentPolicy(
        who,
        order.id,
        {
          expectedPaymentRevision: p.paymentRevision,
          orderTermsDigest: p.orderTermsDigest,
          policyVersionId: p.policyVersionId,
          policyDigest: p.policyDigest,
        },
        key(),
      );
    v = await f.market.participantPayment(P, "order", order.id);
    const plan = await f.market.proposePaymentFeePlan(
      P,
      "order",
      order.id,
      {
        policyVersionId: v.feePlan.context.policyId,
        policyDigest: v.feePlan.context.policyDigest,
        sourceDigest: v.feePlan.context.sourceDigest,
      },
      key(),
    );
    for (const who of [P, C])
      await f.market.confirmPaymentFeePlan(
        who,
        plan.receipt.planId,
        { digest: plan.receipt.digest },
        key(),
      );
    const q = (
      await f.market.createOrderPaymentQuote(P, order.id, v.quoteRequest, key())
    ).receipt;
    await pay(f, x, {
      P,
      q,
      attemptRequest: {
        quoteId: q.quoteId,
        quoteDigest: q.quoteDigest,
        expectedObligationRevision: q.obligationRevision,
        acceptedAmountCents: q.quote.chargeTotalCents,
        currency: "USD",
      },
    });
    await onboard(f, x, C);
    await f.market.fulfillOrder(C, order.id, {}, key());
    for (let i = 0; i < 4; i++) await x.worker.tick();
    assert.equal(
      x.transport.transfers.size,
      0,
      "fulfillment alone never releases",
    );
    await f.market.completeOrder(P, order.id, {}, key());
    for (let i = 0; i < 5; i++) await x.worker.tick();
    const payment = await f.market.orderPayment(C, order.id);
    assert.equal(payment.transferredCents, "9950");
    assert.equal((await f.market.getOrder(P, order.id)).state, "completed");
  } finally {
    await f.close();
  }
});

test("nonmonetary amendment creates no new charge and ordinary participant dispute/refund requests remain review only", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f),
      s = await pay(f, x, await quoteAgreement(f, await agreement(f)));
    const base = (await f.market.agreement(s.P, s.g.id)).effectiveTerms;
    const proposal = await f.market.proposeAmendment(
      s.P,
      s.g.id,
      {
        expectedEffectiveTermsId: base.id,
        expectedEffectiveRevision: base.revision,
        reason: "Clarify deliverable only",
        terms: {
          taskTitle: base.terms.taskTitle,
          description: "Clarified local synthetic work description",
          dueDate: base.terms.dueDate,
          rewardCents: base.terms.rewardCents,
          currency: "USD",
          milestones: base.milestones.map((m) => ({
            id: m.id,
            position: m.position,
            title: m.title,
            amountCents: m.amountCents,
            deliverable: m.deliverable,
            acceptanceCriteria: m.acceptanceCriteria,
          })),
          retireMilestoneIds: [],
        },
      },
      key(),
    );
    const aid = proposal.receipt.amendmentId,
      read = await f.market.agreementAmendment(s.P, s.g.id, aid),
      ar = read.amendment ?? read;
    const exact = {
      expectedEffectiveTermsId: ar.baseTerms.id,
      expectedEffectiveRevision: ar.baseTerms.revision,
      expectedProposalRevision: ar.proposalRevision,
      proposedTermsId: ar.proposedTerms.id,
      proposedTermsRevision: ar.proposedTerms.revision,
    };
    for (const who of [s.P, s.C])
      await f.market.confirmAmendment(who, s.g.id, aid, exact, key());
    assert.equal(
      (await f.market.agreement(s.P, s.g.id)).effectiveTerms.id,
      ar.proposedTerms.id,
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.funding_obligations",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      x.transport.calls.filter((c) => c.kind === "checkout").length,
      1,
    );
    let v = await f.market.participantPayment(s.P, "agreement", s.g.id);
    const source = v.refundSources[0];
    const refund = await f.market.requestPaymentRefund(
      s.P,
      "agreement",
      s.g.id,
      {
        obligationId: s.q.obligationId,
        chargeId: source.chargeId,
        expectedPaymentRevision: v.funding.paymentRevision,
        amountCents: 100,
        reason: "Review a synthetic refund request",
        policyVersionId: source.policyVersionId,
      },
      key(),
    );
    assert.equal(refund.receipt.refundStatus, "not_executed");
    v = await f.market.participantPayment(s.P, "agreement", s.g.id);
    const dispute = await f.market.openPaymentDispute(
      s.C,
      "agreement",
      s.g.id,
      {
        expectedPaymentRevision: v.funding.paymentRevision,
        reason: "Synthetic disagreement requiring review",
      },
      key(),
    );
    assert.equal(dispute.receipt.financialDecision, "pending");
    await x.worker.tick();
    v = await f.market.participantPayment(s.P, "agreement", s.g.id);
    assert.equal(v.funding.coverage, "held");
    assert.equal(v.funding.disputes.length, 1);
    assert.equal(v.funding.refundRequests.length, 1);
    assert.equal(x.transport.transfers.size, 0);
  } finally {
    await f.close();
  }
});

test("first amendment quote readiness shares the original money/capability baseline with command", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f),
      s = await pay(f, x, await quoteAgreement(f, await agreement(f)));
    const c = await candidate(f, x, s);
    await sign(f, s, c);
    await onboard(f, x, s.C);
    const current = await f.market.amendmentFinancialPlans(s.P, s.g.id, c.aid);
    assert(
      current.plans[0].blockedReasons.includes("original_money_state_changed"),
    );
    assert(!current.plans[0].allowedActions.includes("request_quote"));
    await assert.rejects(
      f.market.quoteAmendmentFinancialPlan(
        s.P,
        s.g.id,
        c.aid,
        c.p.revision,
        { ...c.exact, digest: c.p.digest },
        key(),
      ),
      { code: "original_money_state_changed" },
    );
    assert.equal(current.plans[0].obligationId, null);
  } finally {
    await f.close();
  }
});

test("below-minimum amendment discloses the exact shortfall without inventing a charge", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f, { fixedCents: 0 }),
      s = await pay(f, x, await quoteAgreement(f, await agreement(f)), 0),
      c = await candidate(f, x, s, { amount: 1 });
    await sign(f, s, c);
    const d = await f.market.amendmentFinancialPlans(s.P, s.g.id, c.aid),
      p = d.plans.at(-1);
    assert.equal(p.plan.principalCents, 1);
    assert.equal(p.plan.chargeTotalCents, 1);
    assert.equal(p.plan.minimumChargeCents, 50);
    assert(p.blockedReasons.includes("amount_below_provider_minimum"));
    assert(!p.allowedActions.includes("request_quote"));
    await assert.rejects(
      f.market.quoteAmendmentFinancialPlan(
        s.P,
        s.g.id,
        c.aid,
        c.p.revision,
        { ...c.exact, digest: c.p.digest },
        key(),
      ),
      { code: "amount_below_provider_minimum" },
    );
    assert.equal(x.transport.sessions.size, 1);
    console.log(
      JSON.stringify({
        principalCents: p.plan.principalCents,
        collectionCents: p.plan.chargeTotalCents,
        minimumCents: p.plan.minimumChargeCents,
        blockedReasons: p.blockedReasons,
        newAttemptCount: 0,
      }),
    );
  } finally {
    await f.close();
  }
});
