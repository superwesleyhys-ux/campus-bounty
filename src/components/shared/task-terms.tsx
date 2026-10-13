import { formatDueDate, isCalendarDate } from "@/lib/task-terms.mjs";
import type { Milestone } from "./types";

export function TargetDeliveryDate({ value }: { value?: string | null }) {
  return (
    <p className="cb-delivery-date">
      <strong>Target delivery date:</strong>{" "}
      {value && isCalendarDate(value) ? (
        <time dateTime={value}>{formatDueDate(value)}</time>
      ) : (
        <span>Not specified</span>
      )}
    </p>
  );
}

export function MilestoneRequirements({
  milestone,
}: {
  milestone: Pick<Milestone, "deliverable" | "acceptance_criteria">;
}) {
  return (
    <div className="cb-milestone-requirements">
      <p className="cb-prewrap">
        <strong>Expected deliverable</strong>
        <br />
        {milestone.deliverable}
      </p>
      <p className="cb-prewrap">
        <strong>Acceptance criteria</strong>
        <br />
        {milestone.acceptance_criteria?.trim() ||
          "Not specified in this listing."}
      </p>
    </div>
  );
}
