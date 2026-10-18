import { Field, PendingButton } from "./ui";
import type { FulfillmentDraft, MilestoneSnapshot } from "./fulfillment-types";
export function FulfillmentForm({
  publisher,
  snapshot,
  draft,
  blocked,
  busy,
  frozen,
  reviewed,
  setReviewed,
  edit,
  submit,
}: {
  publisher: boolean;
  snapshot: MilestoneSnapshot;
  draft: FulfillmentDraft | null;
  blocked: boolean;
  busy: boolean;
  frozen: boolean;
  reviewed: boolean;
  setReviewed: (v: boolean) => void;
  edit: (field: "content" | "feedback", value: string) => void;
  submit: (operation: "submit" | "revision_requested" | "accepted") => void;
}) {
  const m = snapshot.milestone,
    latest = snapshot.submissions.at(-1);
  const requirements = (
    latest?.milestoneTerms?.acceptanceCriteria ??
    m.effectiveTerms?.acceptanceCriteria ??
    m.acceptance_criteria
  )?.trim()
    ? "agreed deliverable and acceptance criteria"
    : "agreed deliverable";
  if (m.state === "accepted") return null;
  if (!publisher)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit("submit");
        }}
      >
        {m.state === "submitted" && latest && (
          <p className="cb-alert" role="status">
            Waiting for the publisher to review version {latest.version}. You
            can submit a new version until this milestone is accepted.
          </p>
        )}
        {snapshot.effectiveRevision && (
          <p>
            Submitting under current terms {snapshot.effectiveRevision}. Review
            the current scope, date and stage requirements before sending.
          </p>
        )}
        <Field
          label={latest ? "Revised deliverable" : "Your deliverable"}
          help="Describe the work and include relevant HTTPS links. Uploads are not available yet. Drafts stay in this browser tab for this account when browser storage is available."
        >
          <textarea
            required
            maxLength={10000}
            rows={5}
            value={draft?.content ?? ""}
            disabled={frozen}
            onChange={(e) => edit("content", e.target.value)}
          />
        </Field>
        <PendingButton busy={busy} disabled={blocked || !draft?.content.trim()}>
          {latest ? "Submit new version" : "Submit for review"}
        </PendingButton>
      </form>
    );
  if (!latest || m.state !== "submitted")
    return m.state === "revision_requested" ? (
      <p className="cb-muted">
        Waiting for a revised deliverable. The request and the reviewed version
        remain in the history above.
      </p>
    ) : null;
  return (
    <div className="cb-review-form">
      <p>
        Review version {latest.version}
        {latest.submissionTermsRevision
          ? ` under its historical terms ${latest.submissionTermsRevision}`
          : ""}{" "}
        against the {requirements}. Feedback requests corrections within those
        terms; it does not add new scope to the agreement.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit("revision_requested");
        }}
      >
        <Field
          label="Changes needed"
          help={`Explain what needs changing and how it relates to the ${requirements}. This feedback becomes a permanent review record.`}
        >
          <textarea
            required
            maxLength={10000}
            rows={4}
            value={draft?.feedback ?? ""}
            disabled={frozen}
            onChange={(e) => edit("feedback", e.target.value)}
          />
        </Field>
        <PendingButton
          busy={busy}
          disabled={blocked || !draft?.feedback.trim()}
        >
          Request changes to version {latest.version}
        </PendingButton>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit("accepted");
        }}
      >
        <label className="cb-check">
          <input
            type="checkbox"
            required
            checked={reviewed}
            disabled={blocked}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          I have reviewed version {latest.version} against the {requirements}.
        </label>
        <p className="cb-fine">
          Acceptance records this version as complete. It does not transfer
          funds.
        </p>
        <PendingButton busy={busy} disabled={blocked || !reviewed}>
          Accept version {latest.version}
        </PendingButton>
      </form>
    </div>
  );
}
