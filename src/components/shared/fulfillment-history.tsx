import type { MilestoneSnapshot } from "./fulfillment-types";
export function FulfillmentHistory({
  snapshot,
}: {
  snapshot: MilestoneSnapshot;
}) {
  const latest = snapshot.submissions.at(-1);
  const renderReviews = (id: string) =>
    snapshot.reviews
      .filter((r) => r.submission_id === id)
      .map((r) => (
        <div
          id={`review-${r.id}`}
          tabIndex={-1}
          className="cb-review-record"
          key={r.id}
        >
          <h4>
            {r.decision === "accepted" ? "Accepted" : "Changes requested"} ·
            Version {r.submission_version}
          </h4>
          {r.feedback && <p className="cb-prewrap">{r.feedback}</p>}
          <time dateTime={r.created_at}>
            {new Date(r.created_at).toLocaleString("en-US")}
          </time>
        </div>
      ));
  return (
    <>
      {!latest && <p className="cb-muted">No work submitted yet.</p>}
      {latest && (
        <div
          id={`submission-${latest.id}`}
          tabIndex={-1}
          className="cb-deliverable"
        >
          <h3>Latest submission · Version {latest.version}</h3>
          <p className="cb-prewrap">{latest.content}</p>
          <time dateTime={latest.created_at}>
            {new Date(latest.created_at).toLocaleString("en-US")}
          </time>
          {renderReviews(latest.id)}
        </div>
      )}
      {snapshot.submissions.length > 1 && (
        <details className="cb-fulfillment-history">
          <summary>
            Previous versions ({snapshot.submissions.length - 1})
          </summary>
          {snapshot.submissions.slice(0, -1).map((s) => (
            <section id={`submission-${s.id}`} tabIndex={-1} key={s.id}>
              <h3>Version {s.version}</h3>
              <p className="cb-prewrap">{s.content}</p>
              <time dateTime={s.created_at}>
                {new Date(s.created_at).toLocaleString("en-US")}
              </time>
              {renderReviews(s.id)}
            </section>
          ))}
        </details>
      )}
    </>
  );
}
