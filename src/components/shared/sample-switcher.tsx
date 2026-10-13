"use client";
import { useMutation } from "./api";
import type { Account } from "./types";
import { Feedback } from "./ui";
export function SampleSwitcher({
  account,
  onSuccess,
}: {
  account: Account;
  onSuccess: () => void;
}) {
  const change = useMutation("sample-switch");
  return (
    <section className="cb-panel" aria-label="Switch sample account">
      <p>
        <strong>Current sample: {account.display_name}</strong> ·{" "}
        {account.can_apply
          ? "Eligible student · can publish and apply to others’ bounties"
          : "Publisher · student eligibility required to apply"}
      </p>
      <p className="cb-fine">
        Switch fixed local sample identities to try both sides. Your current
        page is kept; private conversations are checked for the selected
        account.
      </p>
      <div className="cb-actions">
        {(
          [
            ["student", "Alex · eligible student"],
            ["applicant", "Sam · eligible student"],
            ["publisher", "Professor · publisher"],
          ] as const
        ).map(([role, label]) => (
          <button
            key={role}
            className="cb-button"
            disabled={change.busy}
            onClick={async () => {
              const result = await change.run("auth/preview", { role }, "");
              if (result) {
                window.dispatchEvent(new Event("campus:session-expired"));
                onSuccess();
              }
            }}
          >
            Switch to {label}
          </button>
        ))}
      </div>
      <Feedback error={change.error} />
    </section>
  );
}
