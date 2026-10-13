import { useEffect, useId, useRef } from "react";
import { type TeamAction, teamCommitments } from "./team-types";
import { Feedback } from "./ui";

export function TeamConfirm({
  action,
  phase,
  stale,
  error,
  checking,
  onConfirm,
  onCancel,
  onCheck,
}: {
  action: TeamAction;
  phase: "idle" | "sending" | "unknown";
  stale: boolean;
  error: Error | null;
  checking: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onCheck: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(),
    descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const unknown = phase === "unknown",
    busy = phase === "sending" || checking;
  return (
    <dialog
      ref={dialog}
      className="cb-team-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']",
          ),
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !unknown) onCancel();
      }}
    >
      <h2 id={titleId}>{action.title}</h2>
      <p id={descriptionId}>{action.description}</p>
      {["leave", "remove", "transfer", "archive"].includes(action.kind) && (
        <p className="cb-team-commitments">
          {teamCommitments}
          {action.kind === "transfer" &&
            " Transferring this team does not change the captain recorded on an existing agreement."}
        </p>
      )}
      <Feedback error={error} />
      {unknown && (
        <p role="status">
          The response was interrupted. This action may already have completed.
          Check the current state or retry the exact same request. Other team
          actions are paused until this is resolved.
        </p>
      )}
      {stale && !unknown && (
        <p role="alert">
          This team changed after you opened this action. Close this panel,
          review the refreshed team, and choose the action again.
        </p>
      )}
      <div className="cb-team-actions">
        {unknown ? (
          <button className="cb-button" disabled={busy} onClick={onCheck}>
            {checking ? "Checking…" : "Check current state"}
          </button>
        ) : (
          <button
            autoFocus
            className="cb-button"
            disabled={busy}
            onClick={onCancel}
          >
            {stale ? "Close and review team" : "Cancel"}
          </button>
        )}
        <button
          className="cb-button cb-primary"
          disabled={busy || (stale && !unknown)}
          onClick={onConfirm}
        >
          {phase === "sending"
            ? "Saving…"
            : unknown
              ? "Retry same request"
              : `Confirm: ${action.title}`}
        </button>
      </div>
    </dialog>
  );
}
