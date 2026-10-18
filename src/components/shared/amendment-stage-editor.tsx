import type { EditableStage } from "./amendment-types";
import { Field } from "./ui";
export function AmendmentStageEditor({
  stage,
  index,
  protectedWork,
  previouslyIncluded,
  patch,
}: {
  stage: EditableStage;
  index: number;
  protectedWork: boolean;
  previouslyIncluded: boolean;
  patch: (field: string, value: unknown) => void;
}) {
  const i = index;
  return (
    <fieldset className="cb-amendment-stage">
      <legend>
        Stage {stage.position ?? i + 1}
        {stage.retired ? " · Retiring" : ""}
      </legend>
      {protectedWork && (
        <p className="cb-alert">
          Protected started work: a submission already exists. Its title,
          deliverable, criteria and reward cannot be edited or retired. Add a
          follow-up stage for new requirements.
        </p>
      )}
      <fieldset disabled={protectedWork || stage.retired}>
        <legend>Stage definition</legend>
        <Field label={`Stage ${i + 1} title`}>
          <input
            required
            maxLength={160}
            value={stage.title}
            onChange={(e) => patch("title", e.target.value)}
          />
        </Field>
        <Field label={`Stage ${i + 1} reward (USD)`}>
          <input
            required
            inputMode="decimal"
            value={stage.amount}
            onChange={(e) => patch("amount", e.target.value)}
          />
        </Field>
        <Field label={`Stage ${i + 1} deliverable`}>
          <textarea
            required
            maxLength={10000}
            rows={3}
            value={stage.deliverable}
            onChange={(e) => patch("deliverable", e.target.value)}
          />
        </Field>
        <Field label={`Stage ${i + 1} acceptance criteria`}>
          <textarea
            maxLength={10000}
            rows={3}
            value={stage.acceptanceCriteria}
            onChange={(e) => patch("acceptanceCriteria", e.target.value)}
          />
        </Field>
      </fieldset>
      {!protectedWork && (
        <label className="cb-check">
          <input
            type="checkbox"
            checked={stage.retired}
            onChange={(e) => patch("retired", e.target.checked)}
          />
          {previouslyIncluded
            ? "Retire this untouched stage"
            : "Exclude this proposed stage"}
        </label>
      )}
    </fieldset>
  );
}
