import type { AmendmentOperation, AmendmentResult } from "./amendment-types";
export type Pending = {
  account: string;
  agreement: string;
  path: string;
  body: Record<string, unknown>;
  key: string;
  storage: string;
  operation: AmendmentOperation;
  proposal?: string;
};
const suffix = {
  propose: "",
  revise: "revisions",
  confirm: "confirmations",
  reject: "rejections",
  withdraw: "withdrawals",
};
export function amendmentPath(
  agreement: string,
  operation: AmendmentOperation,
  proposal?: string,
) {
  return `agreements/${agreement}/amendments${operation === "propose" ? "" : `/${proposal}/${suffix[operation]}`}`;
}
export function verifyAmendmentReceipt(
  value: AmendmentResult,
  frozen: Pending,
) {
  const uuid = (v: unknown) =>
    typeof v === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const r = value?.receipt,
    b = frozen.body;
  if (
    !r ||
    r.operation !== frozen.operation ||
    r.agreementId !== frozen.agreement ||
    value.agreement?.id !== frozen.agreement ||
    !uuid(r.eventId) ||
    !uuid(r.termsId) ||
    !uuid(r.amendmentId) ||
    !uuid(value.effectiveTerms?.id) ||
    !Number.isInteger(value.effectiveTerms?.revision) ||
    typeof value.agreement?.state !== "string" ||
    typeof value.amendment?.status !== "string" ||
    !Number.isInteger(value.amendment?.proposalRevision) ||
    ![
      "pending",
      "effective",
      "agreed_waiting_funds",
      "rejected",
      "withdrawn",
      "stale_base",
      "stale_work",
      "stale_agreement",
    ].includes(r.outcomeAtCommit) ||
    r.termsRevision < 1 ||
    r.proposalRevision < 1 ||
    typeof r.termsId !== "string" ||
    !Number.isInteger(r.termsRevision) ||
    !Number.isInteger(r.proposalRevision) ||
    typeof r.amendmentId !== "string" ||
    value.amendment?.id !== r.amendmentId ||
    (frozen.proposal && r.amendmentId !== frozen.proposal)
  )
    throw new Error("Unverified amendment receipt. Recover the same request.");
  const expected =
    frozen.operation === "propose"
      ? 1
      : Number(b.expectedProposalRevision) +
        (frozen.operation === "revise" ? 1 : 0);
  if (
    r.proposalRevision !== expected ||
    (!["propose", "revise"].includes(frozen.operation) &&
      (r.termsId !== b.proposedTermsId ||
        r.termsRevision !== b.proposedTermsRevision))
  )
    throw new Error(
      "Receipt identifies different proposal terms. Recover the same request.",
    );
  if (
    frozen.operation === "confirm" &&
    (r.confirmation?.userId !== frozen.account ||
      r.confirmation.amendmentId !== r.amendmentId ||
      r.confirmation.proposalRevision !== r.proposalRevision)
  )
    throw new Error("Confirmation identity could not be verified.");
}
