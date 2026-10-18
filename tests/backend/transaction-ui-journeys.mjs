import {key} from "./transaction-ui-fixture.mjs";
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
  const prepared = await m.preparePaymentTerms(C,"application",a,{},key());
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
  return { P, C, M, g, pol, members, applicationId:a };
}
