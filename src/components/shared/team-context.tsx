import type { TeamContext } from "./types";
import { Field } from "./ui";

const contextFields: {
  key: keyof TeamContext;
  label: string;
  help: string;
  limit: number;
  required: boolean;
}[] = [
  {
    key: "purpose",
    label: "Team purpose",
    help: "Explain what this team will work toward. Teammates see this before deciding to join.",
    limit: 1000,
    required: true,
  },
  {
    key: "activities",
    label: "Activities and schedule",
    help: "Describe the expected activities, meetings, and any regular schedule.",
    limit: 1500,
    required: true,
  },
  {
    key: "timeCommitment",
    label: "Expected time commitment",
    help: "State hours per week, duration, or another concrete time expectation.",
    limit: 500,
    required: true,
  },
  {
    key: "projectContext",
    label: "Project background (optional)",
    help: "Add useful project context. This background is informational, not signed agreement terms.",
    limit: 1500,
    required: false,
  },
];

export function TeamContextFields({
  value,
  onChange,
  disabled,
}: {
  value: TeamContext;
  onChange: (value: TeamContext) => void;
  disabled: boolean;
}) {
  return (
    <div className="cb-team-context-fields">
      {contextFields.map((field) => (
        <Field key={field.key} label={field.label} help={field.help}>
          <textarea
            name={field.key}
            rows={field.key === "timeCommitment" ? 2 : 3}
            required={field.required}
            maxLength={field.limit}
            disabled={disabled}
            value={value[field.key]}
            onChange={(event) =>
              onChange({ ...value, [field.key]: event.target.value })
            }
          />
        </Field>
      ))}
    </div>
  );
}

export function TeamContextView({ context }: { context: TeamContext | null }) {
  if (!context) return null;
  return (
    <section className="cb-team-context">
      <h3>Team background</h3>
      <p className="cb-muted">
        Team background is visible to current members and invited teammates.
      </p>
      <dl>
        {contextFields
          .filter((field) => field.required || context[field.key])
          .map((field) => (
            <div key={field.key}>
              <dt>
                {field.key === "projectContext"
                  ? "Project background"
                  : field.label}
              </dt>
              <dd className="cb-prewrap">
                {context[field.key] ||
                  "Not provided. Ask the captain for this information before deciding to join."}
              </dd>
            </div>
          ))}
      </dl>
      <p className="cb-muted">
        Joining this team does not accept a bounty proposal or agreement. This
        background is informational and is not signed agreement terms.
      </p>
    </section>
  );
}
