"use client";
import { useEffect, useRef, useState } from "react";
import type { Agreement } from "./types";
import type { AmendmentDraft, TermsSnapshot } from "./amendment-types";
import { draftBody } from "./amendment-model";
import { AmendmentComparison } from "./amendment-comparison";
import { AmendmentStageEditor } from "./amendment-stage-editor";
import { Field, Feedback } from "./ui";
export function AmendmentForm({
  draft,
  agreement,
  disabled,
  setDraft,
  publish,
  close,
}: {
  draft: AmendmentDraft;
  agreement: Agreement;
  disabled: boolean;
  setDraft: (d: AmendmentDraft) => void;
  publish: (body: Record<string, unknown>) => void;
  close: () => void;
}) {
  const [error, setError] = useState<Error | null>(null),
    [comparison, setComparison] = useState<Record<string, unknown> | null>(
      null,
    );
  const validation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) validation.current?.focus();
  }, [error]);
  const comparisonTitle = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (comparison) {
      dialog.current?.showModal();
      comparisonTitle.current?.focus({ preventScroll: true });
      if (dialog.current) dialog.current.scrollTop = 0;
    }
  }, [comparison]);
  function closeComparison() {
    dialog.current?.close();
    setComparison(null);
    opener.current?.focus();
  }
  const update = (field: string, value: unknown) => {
    setError(null);
    setDraft({ ...draft, [field]: value });
  };
  const terms = comparison?.terms as
    | (TermsSnapshot["terms"] & { milestones: Array<Record<string, unknown>> })
    | undefined;
  const proposed: TermsSnapshot | null = terms
    ? {
        ...draft.base,
        terms,
        milestones: terms.milestones.map((m, i) => ({
          id: String(m.id ?? m.clientReference),
          position: Number(m.position ?? i + 1),
          title: String(m.title),
          amountCents: Number(m.amountCents),
          deliverable: String(m.deliverable),
          acceptanceCriteria: m.acceptanceCriteria as string | null,
        })),
      }
    : null;
  return (
    <section className="cb-panel cb-amendment-form">
      <h3>{draft.proposalRevision ? "Revise proposal" : "Draft a change"}</h3>
      <p>
        Based on current terms {draft.base.revision}. Publishing is not
        confirmation. Every original party must confirm separately.
      </p>
      <div ref={validation} tabIndex={-1}>
        <Feedback error={error} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setComparison(draftBody(draft));
            setError(null);
          } catch (cause) {
            setError(cause as Error);
          }
        }}
      >
        <fieldset disabled={disabled}>
          <legend>Proposed agreement terms</legend>
          <Field label="Agreement title">
            <input
              required
              maxLength={160}
              value={draft.taskTitle}
              onChange={(e) => update("taskTitle", e.target.value)}
            />
          </Field>
          <Field label="General scope">
            <textarea
              required
              maxLength={10000}
              rows={4}
              value={draft.description}
              onChange={(e) => update("description", e.target.value)}
            />
          </Field>
          <Field label="Proposed target date">
            <input
              type="date"
              min="1000-01-01"
              max="9999-12-31"
              value={draft.dueDate}
              onChange={(e) => update("dueDate", e.target.value)}
            />
          </Field>
          <Field
            label="Proposed total reward (USD)"
            help="Review the work change first. A supported increase requires separate personal financial consent and funding before activation."
          >
            <input
              required
              inputMode="decimal"
              value={draft.reward}
              onChange={(e) => update("reward", e.target.value)}
            />
          </Field>
          {draft.stages.map((stage, i) => (
            <AmendmentStageEditor
              key={stage.id ?? stage.clientReference}
              stage={stage}
              index={i}
              protectedWork={
                !!agreement.milestones.find((m) => m.id === stage.id)
                  ?.protectedWork
              }
              previouslyIncluded={draft.base.milestones.some(
                (m) => m.id === stage.id,
              )}
              patch={(field, value) =>
                update(
                  "stages",
                  draft.stages.map((m, j) =>
                    j === i ? { ...m, [field]: value } : m,
                  ),
                )
              }
            />
          ))}
          <button
            type="button"
            className="cb-button"
            disabled={draft.stages.filter((m) => !m.retired).length >= 20}
            onClick={() =>
              update("stages", [
                ...draft.stages,
                {
                  clientReference: crypto.randomUUID(),
                  title: "",
                  deliverable: "",
                  acceptanceCriteria: "",
                  amount: "",
                  retired: false,
                },
              ])
            }
          >
            Add future stage
          </button>
          <Field label="Reason for this change">
            <textarea
              required
              rows={3}
              maxLength={10000}
              value={draft.reason}
              onChange={(e) => update("reason", e.target.value)}
            />
          </Field>
          <button ref={opener} type="submit" className="cb-button cb-primary">
            Review comparison
          </button>
        </fieldset>
      </form>
      <button className="cb-button" disabled={disabled} onClick={close}>
        Close draft (keep edits)
      </button>
      <dialog
        ref={dialog}
        className="cb-amendment-dialog"
        aria-labelledby="amendment-comparison-title"
        onCancel={(e) => {
          e.preventDefault();
          closeComparison();
        }}
      >
        <h2 ref={comparisonTitle} tabIndex={-1} id="amendment-comparison-title">
          Review proposed change
        </h2>
        {proposed && (
          <AmendmentComparison base={draft.base} proposed={proposed} />
        )}
        <p>
          Publish this exact proposal. You will still need to explicitly confirm
          its recorded revision.
        </p>
        <button className="cb-button" onClick={closeComparison}>
          Back to editing
        </button>
        <button
          className="cb-button cb-primary"
          disabled={disabled}
          onClick={() => {
            const body = comparison!;
            closeComparison();
            publish(body);
          }}
        >
          Publish proposal
        </button>
      </dialog>
    </section>
  );
}
