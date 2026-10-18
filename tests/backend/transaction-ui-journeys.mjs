import { key } from "./transaction-ui-fixture.mjs";
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
  const prepared = await m.preparePaymentTerms(C, "application", a, {}, key());
  const pol = prepared.receipt.policyVersionId;
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
  return { P, C, M, g, pol, members, applicationId: a };
}
export async function quoteAgreement(f, s) {
  const m = f.market;
  await m.preparePaymentTerms(s.P, "agreement", s.g.id, {}, key());
  const v = await m.participantPayment(s.P, "agreement", s.g.id);
  const plan = await m.proposePaymentFeePlan(
    s.P,
    "agreement",
    s.g.id,
    {
      policyVersionId: v.feePlan.context.policyId,
      policyDigest: v.feePlan.context.policyDigest,
      sourceDigest: v.feePlan.context.sourceDigest,
    },
    key(),
  );
  for (const actor of [s.P, ...s.members])
    await m.confirmPaymentFeePlan(
      actor,
      plan.receipt.planId,
      { digest: plan.receipt.digest },
      key(),
    );
  const q = (
    await m.createAgreementPaymentQuote(s.P, s.g.id, v.quoteRequest, key())
  ).receipt;
  return {
    ...s,
    quoteRequest: v.quoteRequest,
    plan,
    q,
    attemptRequest: {
      quoteId: q.quoteId,
      quoteDigest: q.quoteDigest,
      expectedObligationRevision: q.obligationRevision,
      acceptedAmountCents: q.quote.chargeTotalCents,
      currency: "USD",
    },
  };
}
export async function pay(f, x, s, fee = 100) {
  const a = (
    await f.market.createPaymentAttempt(
      s.P,
      s.q.obligationId,
      s.attemptRequest,
      key(),
    )
  ).receipt;
  let read;
  for (let i = 0; i < 20; i++) {
    await x.worker.dispatch();
    read = await f.market.paymentAttempt(s.P, a.attemptId);
    if (read.sessionId) break;
  }
  if (!read.sessionId)
    throw Error(
      "Exact payment attempt did not reach hosted Checkout: " + read.status,
    );
  x.transport.pay(read.sessionId, { fee, available: true });
  const { createPosting } = await import("../../backend/payments/posting.mjs");
  const expected = (
    await f.store.workerTx((c) =>
      c.query("SELECT campus.money_find_attempt($1,$2) result", [
        x.env.id,
        read.sessionId,
      ]),
    )
  ).rows[0].result;
  await createPosting(f.store, x.env).payment(
    expected,
    await x.adapter.retrieveCheckoutAndPayment(read.sessionId),
  );
  return { ...s, a };
}
export async function onboard(f, x, actor) {
  await f.market.preparePaymentRecipient(actor, {}, key());
  await f.market.onboardPaymentAccount(
    actor,
    { expectedAccountRevision: 0 },
    key(),
  );
  await x.worker.dispatch();
  await x.worker.refreshRecipients();
}
export async function acceptStage(f, s, index = 0) {
  let g = await f.market.agreement(s.C, s.g.id),
    stage = g.milestones[index],
    terms = g.effectiveTerms,
    b = g.transaction.bindings.find((b) => b.terms_id === terms.id);
  await f.market.submitMilestone(
    s.C,
    stage.id,
    {
      expectedVersion: stage.version,
      expectedRevision: stage.revision,
      content: "Synthetic completed deliverable",
      expectedEffectiveTermsId: terms.id,
      expectedEffectiveRevision: terms.revision,
    },
    key(),
  );
  g = await f.market.agreement(s.P, s.g.id);
  stage = g.milestones[index];
  await f.market.acceptMilestone(
    s.P,
    stage.id,
    {
      submissionId: stage.latest_submission_id,
      expectedVersion: stage.version,
      expectedRevision: stage.revision,
      submissionTermsId: terms.id,
      submissionTermsRevision: terms.revision,
      transactionTermsId: b.transaction_terms_id,
      transactionTermsRevision: b.transaction_terms_revision,
    },
    key(),
  );
}

export async function candidate(f, x, s, { amount = 1000, fee = 20 } = {}) {
  const gd = await f.market.agreement(s.P, s.g.id),
    base = gd.effectiveTerms;
  const terms = base.terms;
  const proposed = await f.market.proposeAmendment(
    s.P,
    s.g.id,
    {
      expectedEffectiveTermsId: base.id,
      expectedEffectiveRevision: base.revision,
      reason: "Explicit extra work",
      terms: {
        taskTitle: terms.taskTitle,
        description: terms.description,
        dueDate: terms.dueDate,
        rewardCents: terms.rewardCents + amount,
        currency: "USD",
        milestones: [
          ...base.milestones.map((m) => ({
            id: m.id,
            position: m.position,
            title: m.title,
            amountCents: m.amountCents,
            deliverable: m.deliverable,
            acceptanceCriteria: m.acceptanceCriteria,
          })),
          {
            clientReference: "added",
            title: "Additional report",
            amountCents: amount,
            deliverable: "New report",
            acceptanceCriteria: null,
          },
        ],
        retireMilestoneIds: [],
      },
    },
    key(),
  );
  const a = proposed.amendment ?? proposed.current?.amendment;
  const aid = proposed.receipt.amendmentId;
  const read = await f.market.agreementAmendment(s.P, s.g.id, aid);
  const ar = read.amendment ?? read;
  const exact = {
    expectedEffectiveTermsId: ar.baseTerms.id,
    expectedEffectiveRevision: ar.baseTerms.revision,
    expectedProposalRevision: ar.proposalRevision,
    proposedTermsId: ar.proposedTerms.id,
    proposedTermsRevision: ar.proposedTerms.revision,
  };
  const prep = await f.market.preparePaymentTerms(
    s.P,
    "amendment",
    aid,
    {},
    key(),
  );
  const policyId = prep.receipt.policyVersionId;
  const plan = await f.market.proposeAmendmentFinancialPlan(
    s.P,
    s.g.id,
    aid,
    {
      ...exact,
      policyVersionId: policyId,
      policyDigest: prep.receipt.policyDigest,
    },
    key(),
  );
  return { aid, exact, plan, p: plan.current.plans.at(-1) };
}

export async function sign(f, s, c) {
  for (const actor of [s.P, ...s.members]) {
    await f.market.confirmAmendment(actor, s.g.id, c.aid, c.exact, key());
    await f.market.confirmAmendmentFinancialPlan(
      actor,
      s.g.id,
      c.aid,
      c.p.revision,
      { ...c.exact, digest: c.p.digest, feePlanDigest: c.p.feePlanDigest },
      key(),
    );
  }
}
