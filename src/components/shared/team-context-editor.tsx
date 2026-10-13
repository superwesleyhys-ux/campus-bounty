import { useEffect, useId, useRef } from "react";
import { Feedback } from "./ui";
import { TeamContextFields, TeamContextView } from "./team-context";
import { hasTeamContext } from "./team-types";
import {
  useTeamContextDraft,
  type TeamContextEditorProps,
} from "./team-context-draft";

export function TeamContextEditor(props: TeamContextEditorProps) {
  const { team, onClose } = props;
  const {
    draft,
    setDraft,
    discard,
    setDiscard,
    checking,
    checked,
    readError,
    mutation,
    conflict,
    canEdit,
    unknown,
    readCurrent,
    close,
    save,
    rebase,
  } = useTeamContextDraft(props);
  const dialog = useRef<HTMLDialogElement>(null);
  const conflictMessage = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    dialog.current
      ?.querySelector<HTMLElement>(
        discard ? ".cb-team-discard button" : "textarea",
      )
      ?.focus();
  }, [discard]);
  useEffect(() => {
    if (conflict && !unknown) conflictMessage.current?.focus();
  }, [conflict, unknown]);
  return (
    <dialog
      ref={dialog}
      className="cb-team-dialog cb-team-context-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']",
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
    >
      <h2 id={titleId}>Edit team background</h2>
      {discard ? (
        <div className="cb-team-discard">
          <p role="alert">Discard your unsaved background changes?</p>
          <div className="cb-team-actions">
            <button
              autoFocus
              className="cb-button cb-primary"
              onClick={() => setDiscard(false)}
            >
              Keep editing
            </button>
            <button className="cb-button" onClick={onClose}>
              Discard changes
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>
            Current members and invited teammates can read this background. It
            does not change existing bounty proposals or signed agreements.
          </p>
          <TeamContextFields
            value={draft}
            onChange={setDraft}
            disabled={mutation.unresolved || checking || !canEdit}
          />
          <Feedback error={readError || mutation.error} />
          {unknown && (
            <p role="status">
              The response was interrupted. Your update may already be saved.
              The draft and original request are frozen. Retry the same update
              to resolve it safely.
            </p>
          )}
          {conflict && !unknown && (
            <div
              ref={conflictMessage}
              tabIndex={-1}
              className="cb-alert"
              role="alert"
            >
              <p>
                This team changed while you were editing. Review the current
                saved background below. Your draft is unchanged.
              </p>
              {canEdit && (
                <button
                  type="button"
                  className="cb-button"
                  disabled={checking}
                  onClick={rebase}
                >
                  Use latest version and review draft
                </button>
              )}
            </div>
          )}
          {!canEdit && (
            <p role="alert">
              Only the current captain of an active team can edit its background
              while their account is not locked.
            </p>
          )}
          {(conflict || checked) && (
            <div className="cb-team-saved-context">
              <h3>Currently saved</h3>
              {team.can_view_roster ? (
                <TeamContextView context={team.context} />
              ) : (
                <p>
                  Your team membership has ended. Team background is no longer
                  available.
                </p>
              )}
              {unknown && (
                <p>
                  These are the current saved values. They do not establish
                  whether your original request completed. Retry the same update
                  to resolve the request.
                </p>
              )}
            </div>
          )}
          <div className="cb-team-actions">
            {unknown ? (
              <button
                type="button"
                className="cb-button"
                disabled={checking || mutation.busy}
                onClick={readCurrent}
              >
                {checking ? "Checking…" : "Check saved background"}
              </button>
            ) : (
              <button
                type="button"
                className="cb-button"
                disabled={mutation.busy || checking}
                onClick={close}
              >
                Cancel editing
              </button>
            )}
            <button
              type="submit"
              className="cb-button cb-primary"
              disabled={
                mutation.busy ||
                checking ||
                (!unknown && (conflict || !canEdit || !hasTeamContext(draft)))
              }
            >
              {mutation.busy
                ? "Saving…"
                : unknown
                  ? "Retry same background update"
                  : "Save team background"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
