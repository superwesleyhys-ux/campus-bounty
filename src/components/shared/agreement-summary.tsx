import type { Agreement } from "./types";
export function AgreementSummary({
  agreement,
  publisher,
}: {
  agreement: Agreement;
  publisher: boolean;
}) {
  const counts = agreement.milestone_counts;
  if (agreement.state === "completed")
    return (
      <p className="cb-agreement-next">
        <strong>Completed.</strong> All milestones accepted. No funds were
        transferred.
      </p>
    );
  if (["awaiting_funding", "pending_funding"].includes(agreement.state))
    return (
      <p className="cb-agreement-next">
        <strong>Waiting for funding.</strong> The publisher must fund the
        agreement before work starts. Payments are not enabled in this preview.
      </p>
    );
  if (agreement.state !== "active")
    return (
      <p className="cb-agreement-next">
        Open the agreement to check its current status before continuing.
      </p>
    );
  if (!counts)
    return (
      <p className="cb-agreement-next">
        Open the agreement to check its milestones.
      </p>
    );
  return (
    <div className="cb-agreement-next">
      {publisher ? (
        <p>
          <strong>
            {counts.submitted > 0
              ? `Your turn: review ${counts.submitted} submitted ${counts.submitted === 1 ? "draft" : "drafts"}.`
              : counts.accepted === counts.total && counts.total > 0
                ? "Your turn: record agreement completion."
                : "Waiting for participant work."}
          </strong>
        </p>
      ) : (
        <p>
          <strong>
            {counts.revision_requested > 0
              ? `Your turn: changes requested on ${counts.revision_requested} ${counts.revision_requested === 1 ? "milestone" : "milestones"}.`
              : counts.pending > 0
                ? `Your turn: ${counts.pending} ${counts.pending === 1 ? "milestone" : "milestones"} still need initial work.`
                : "Waiting for publisher review or completion."}
          </strong>
        </p>
      )}
      <p className="cb-fine">
        {counts.accepted} of {counts.total} accepted · {counts.submitted}{" "}
        awaiting review · {counts.revision_requested} need changes ·{" "}
        {counts.pending} not submitted
      </p>
    </div>
  );
}
