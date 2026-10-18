import type {
  Amendment,
  AmendmentDraft,
  TermsSnapshot,
} from "./amendment-types";
const decimal = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export function cents(value: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value))
    throw new Error("Enter USD amounts with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 1 || result > 100000000)
    throw new Error("Amounts must be between $0.01 and $1,000,000.00.");
  return result;
}
export function newAmendmentDraft(
  base: TermsSnapshot,
  proposal?: Amendment,
): AmendmentDraft {
  const source = proposal?.proposedTerms ?? base;
  return {
    base,
    proposalRevision: proposal?.proposalRevision,
    reason: proposal?.reason ?? "",
    taskTitle: source.terms.taskTitle,
    description: source.terms.description,
    dueDate: source.terms.dueDate ?? "",
    reward: decimal(source.terms.rewardCents),
    stages: [
      ...source.milestones.map((m) => ({
        ...m,
        amount: decimal(m.amountCents),
        acceptanceCriteria: m.acceptanceCriteria ?? "",
        retired: false,
      })),
      ...base.milestones
        .filter((m) => !source.milestones.some((s) => s.id === m.id))
        .map((m) => ({
          ...m,
          amount: decimal(m.amountCents),
          acceptanceCriteria: m.acceptanceCriteria ?? "",
          retired: true,
        })),
    ],
  };
}
function bounded(value: string, max: number, name: string) {
  const s = value.trim();
  if (!s || s.length > max)
    throw new Error(`${name} must contain 1–${max} characters.`);
  return s;
}
export function draftBody(draft: AmendmentDraft): Record<string, unknown> {
  const stages = draft.stages.filter((m) => !m.retired);
  if (stages.length < 1 || stages.length > 20)
    throw new Error("Include between 1 and 20 stages.");
  if (
    draft.dueDate &&
    (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(draft.dueDate) ||
      new Date(draft.dueDate + "T00:00:00Z").toISOString().slice(0, 10) !==
        draft.dueDate)
  )
    throw new Error("Enter a valid target date, year 1000–9999.");
  const milestones = stages.map((m) => ({
    ...(m.id
      ? { id: m.id, position: m.position }
      : { clientReference: m.clientReference }),
    title: bounded(m.title, 160, "Stage title"),
    amountCents: cents(m.amount),
    deliverable: bounded(m.deliverable, 10000, "Deliverable"),
    acceptanceCriteria: m.acceptanceCriteria.trim()
      ? bounded(m.acceptanceCriteria, 10000, "Acceptance criteria")
      : null,
  }));
  const rewardCents = cents(draft.reward);
  if (milestones.reduce((sum, m) => sum + m.amountCents, 0) !== rewardCents)
    throw new Error(
      "Included stage amounts must equal the total reward exactly.",
    );
  const body = {
    expectedEffectiveTermsId: draft.base.id,
    expectedEffectiveRevision: draft.base.revision,
    ...(draft.proposalRevision
      ? { expectedProposalRevision: draft.proposalRevision }
      : {}),
    reason: bounded(draft.reason, 10000, "Reason"),
    terms: {
      taskTitle: bounded(draft.taskTitle, 160, "Title"),
      description: bounded(draft.description, 10000, "Scope"),
      dueDate: draft.dueDate || null,
      currency: "USD",
      rewardCents,
      milestones,
      retireMilestoneIds: draft.stages
        .filter(
          (m) => m.retired && draft.base.milestones.some((b) => b.id === m.id),
        )
        .map((m) => m.id),
    },
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > 65536)
    throw new Error(
      "The complete proposal exceeds 64 KiB. Shorten the text before sending.",
    );
  return body;
}
export function decisionBody(proposal: Amendment) {
  return {
    expectedEffectiveTermsId: proposal.baseTerms.id,
    expectedEffectiveRevision: proposal.baseTerms.revision,
    expectedProposalRevision: proposal.proposalRevision,
    proposedTermsId: proposal.proposedTerms.id,
    proposedTermsRevision: proposal.proposedTerms.revision,
  };
}
