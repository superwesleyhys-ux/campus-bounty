import { money } from "./types";
import type { StageTerms, TermsSnapshot } from "./amendment-types";
export function TermsView({
  value,
  label,
}: {
  value: TermsSnapshot;
  label: string;
}) {
  return (
    <section className="cb-amendment-terms">
      <h3>
        {label} · Terms {value.revision}
      </h3>
      <p>
        <strong>{value.terms.taskTitle}</strong>
      </p>
      <p>
        Target date: {value.terms.dueDate || "Not specified"} · Reward:{" "}
        {money(value.terms.rewardCents)}
      </p>
      <p className="cb-prewrap">{value.terms.description}</p>
      <ol>
        {value.milestones.map((m) => (
          <li key={m.id}>
            <StageView stage={m} />
          </li>
        ))}
      </ol>
    </section>
  );
}
function StageView({ stage }: { stage: StageTerms }) {
  return (
    <>
      <strong>
        {stage.position}. {stage.title} · {money(stage.amountCents)}
      </strong>
      <p className="cb-prewrap">Deliverable: {stage.deliverable}</p>
      <p className="cb-prewrap">
        Criteria:{" "}
        {stage.acceptanceCriteria || "No additional criteria specified"}
      </p>
    </>
  );
}
export function AmendmentComparison({
  base,
  proposed,
}: {
  base: TermsSnapshot;
  proposed: TermsSnapshot;
}) {
  const ids = [
    ...new Set([
      ...base.milestones.map((m) => m.id),
      ...proposed.milestones.map((m) => m.id),
    ]),
  ];
  return (
    <div className="cb-amendment-comparison">
      <p>
        General scope and date changes govern future submissions. Earlier
        submissions retain their own terms and criteria.
      </p>
      <dl>
        <dt>Title</dt>
        <dd>
          {base.terms.taskTitle} → {proposed.terms.taskTitle}
        </dd>
        <dt>Target date</dt>
        <dd>
          {base.terms.dueDate || "Not specified"} →{" "}
          {proposed.terms.dueDate || "Not specified"}
        </dd>
        <dt>Total reward</dt>
        <dd>
          {money(base.terms.rewardCents)} → {money(proposed.terms.rewardCents)}
        </dd>
        <dt>Current scope</dt>
        <dd className="cb-prewrap">{base.terms.description}</dd>
        <dt>Proposed scope</dt>
        <dd className="cb-prewrap">{proposed.terms.description}</dd>
      </dl>
      {ids.map((id) => {
        const before = base.milestones.find((m) => m.id === id),
          after = proposed.milestones.find((m) => m.id === id);
        const changed = JSON.stringify(before) !== JSON.stringify(after);
        return (
          <section className="cb-panel" key={id}>
            <h4>
              {!before
                ? "Added future stage"
                : !after
                  ? "Retired from included stages"
                  : changed
                    ? "Changed stage"
                    : "Unchanged stage"}
            </h4>
            {before && (
              <div>
                <p>Before</p>
                <StageView stage={before} />
              </div>
            )}
            {after && (
              <div>
                <p>Proposed</p>
                <StageView stage={after} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
