export type StageTerms = {
  id: string;
  position: number;
  title: string;
  amountCents: number;
  deliverable: string;
  acceptanceCriteria: string | null;
};
export type TermsSnapshot = {
  id: string;
  agreementId: string;
  revision: number;
  origin: string;
  recordedAt: string;
  amendmentId: string | null;
  proposalRevision: number | null;
  terms: {
    taskTitle: string;
    description: string;
    dueDate?: string | null;
    rewardCents: number;
    currency?: string;
  };
  milestones: StageTerms[];
};
export type Amendment = {
  id: string;
  agreementId: string;
  proposerId: string;
  proposalRevision: number;
  currentProposalRevision: number;
  status: string;
  reason: string;
  baseTerms: TermsSnapshot;
  proposedTerms: TermsSnapshot;
  participants: {
    userId: string;
    role: string;
    displayName: string | null;
    confirmation: {
      proposalRevision: number;
      termsId: string;
      confirmedAt: string;
    } | null;
  }[];
  allowedActions: Record<"confirm" | "revise" | "reject" | "withdraw", boolean>;
  blockedReasons: string[];
  terminalReason: string | null;
  retiredMilestoneIds: string[];
  addedMilestoneIds: string[];
  funding: { requirement: string; authority: string; changeKind: string };
};
export type AmendmentPage<T> = {
  items: T[];
  nextCursor: string | null;
  effectiveTermsId: string;
  limit: number;
};
export type AmendmentEvent = {
  id: string;
  amendmentId: string;
  proposalRevision: number;
  sequence: number;
  operation: string;
  newStatus: string;
  reason: string | null;
  occurredAt: string;
};
export type EditableStage = {
  id?: string;
  position?: number;
  clientReference?: string;
  title: string;
  amount: string;
  deliverable: string;
  acceptanceCriteria: string;
  retired: boolean;
};
export type AmendmentDraft = {
  base: TermsSnapshot;
  proposalRevision?: number;
  reason: string;
  taskTitle: string;
  description: string;
  dueDate: string;
  reward: string;
  stages: EditableStage[];
};
export type AmendmentOperation =
  "propose" | "revise" | "confirm" | "reject" | "withdraw";
export type AmendmentReceipt = {
  operation: AmendmentOperation;
  agreementId: string;
  amendmentId: string;
  proposalRevision: number;
  termsId: string;
  termsRevision: number;
  eventId: string;
  outcomeAtCommit: string;
  newMilestoneIds?: { clientReference: string; id: string; position: number }[];
  confirmation?: {
    amendmentId: string;
    proposalRevision: number;
    userId: string;
  };
};
export type AmendmentResult = {
  agreement: { id: string; state: string };
  effectiveTerms: { id: string; revision: number };
  amendment: { id: string; proposalRevision: number; status: string };
  receipt: AmendmentReceipt;
};
