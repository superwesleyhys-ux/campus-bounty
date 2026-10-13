"use client";
import { useEffect, useRef, useState } from "react";
import { money, type Account, type Agreement, type Milestone } from "./types";
import { Feedback, Status } from "./ui";
import { MilestoneRequirements } from "./task-terms";
import { FulfillmentHistory } from "./fulfillment-history";
import { FulfillmentForm } from "./fulfillment-form";
import { useFulfillmentRequest } from "./fulfillment-request";
import { useFulfillmentState } from "./fulfillment-state";
import { fulfillmentNotice } from "./fulfillment-copy";
export function MilestonePanel({
  milestone,
  agreement,
  account,
  reload,
}: {
  milestone: Milestone;
  agreement: Agreement;
  account: Account;
  reload: () => void;
}) {
  const state = useFulfillmentState(
    account.id,
    agreement.id,
    milestone.id,
    milestone.revision,
  );
  const mutation = useFulfillmentRequest(account.id, milestone.id);
  const [notice, setNotice] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const feedback = useRef<HTMLDivElement>(null);
  const { snapshot, draft } = state,
    m = snapshot?.milestone ?? milestone;
  const publisher = agreement.owner_id === account.id;
  const outdated = !!draft && draft.revision !== m.revision;
  const canWrite =
    snapshot?.agreementState === "active" &&
    account.account_status === "active" &&
    account.campus_verified;
  useEffect(() => {
    setReviewed(false);
  }, [m.revision]);
  useEffect(() => {
    if (notice || mutation.error || state.error || outdated)
      feedback.current?.focus();
  }, [notice, mutation.error, state.error, outdated]);
  async function refresh() {
    const result = await state.refresh();
    if (result) {
      // Only refresh the parent when its state is stale. Re-loading an unchanged
      // active aggregate would restart child history reads and review controls.
      // Use the server state, never infer completion from an accepted set.
      if (result.agreementState !== agreement.state) reload();
      setNotice(
        mutation.phase === "unknown"
          ? "Current state refreshed. This read does not confirm whether your earlier request succeeded. Retry the same request to obtain its receipt."
          : "Latest version and review history refreshed. Review them before continuing.",
      );
    }
  }
  async function submit(
    operation?: "submit" | "revision_requested" | "accepted",
  ) {
    setNotice("");
    const base = draft ?? state.base();
    const body =
      operation === "submit"
        ? {
            content: base.content,
            expectedVersion: base.version,
            expectedRevision: base.revision,
          }
        : {
            submissionId: base.submissionId,
            expectedVersion: base.version,
            expectedRevision: base.revision,
            ...(operation === "revision_requested"
              ? { feedback: base.feedback }
              : {}),
          };
    const route =
      operation === "submit"
        ? "submissions"
        : operation === "accepted"
          ? "acceptance"
          : "revision-requests";
    const response = await mutation.send(
      operation ? `milestones/${m.id}/${route}` : undefined,
      operation ? body : undefined,
    );
    if (response) {
      const { result, body: sent } = response;
      state.setDraft((current) => {
        if (!current) return null;
        const next = { ...current };
        if (
          result.receipt.operation === "submit" &&
          next.content === sent.content
        )
          next.content = "";
        if (
          result.receipt.operation === "revision_requested" &&
          next.feedback === sent.feedback
        )
          next.feedback = "";
        return next.content || next.feedback ? next : null;
      });
      setNotice(fulfillmentNotice(result, sent, response.recovered));
      reload();
    }
    setReviewed(false);
    await state.refresh();
  }
  return (
    <article
      id={`milestone-${m.id}`}
      tabIndex={-1}
      className="cb-panel cb-fulfillment-milestone"
    >
      <div className="cb-row">
        <h2>
          {m.position}. {m.title}
        </h2>
        <Status value={m.state ?? "pending"} />
      </div>
      <strong>{money(m.amount_cents)}</strong>
      <MilestoneRequirements milestone={m} />
      <button
        className="cb-button"
        disabled={state.loading || mutation.busy}
        onClick={() => void refresh()}
      >
        Refresh milestone
      </button>
      <div ref={feedback} tabIndex={-1} className="cb-fulfillment-feedback">
        <Feedback error={mutation.error ?? state.error} notice={notice} />
        {outdated && (
          <p className="cb-alert" role="alert">
            Your draft was started before this update. Your text is preserved.
            Read the latest submission and feedback before continuing.
          </p>
        )}
      </div>
      {state.loading && (
        <p role="status">Loading milestone and review history…</p>
      )}
      {snapshot && <FulfillmentHistory snapshot={snapshot} />}
      {outdated && m.state !== "accepted" && !mutation.unresolved && (
        <button
          className="cb-button"
          disabled={state.loading || !!state.error || !snapshot}
          onClick={() => {
            state.setDraft(state.base());
            setReviewed(false);
            setNotice(
              "Your draft is kept. Review it against the latest submission and feedback before sending.",
            );
          }}
        >
          Keep draft and review latest version
        </button>
      )}
      {mutation.phase === "unknown" && (
        <div className="cb-alert" role="alert">
          <h3>Request outcome not confirmed</h3>
          <p>
            The exact request is saved for recovery. Refresh to inspect the
            current state, or retry the same request for its receipt. Editing
            stays paused until the request is resolved.
          </p>
          <button className="cb-button" onClick={() => void submit()}>
            Retry same request
          </button>
        </div>
      )}
      {m.state === "accepted" && draft && (draft.content || draft.feedback) && (
        <details className="cb-fulfillment-history">
          <summary>Saved unsent draft</summary>
          <p>This text was not sent. The milestone is already accepted.</p>
          <p className="cb-prewrap">{draft.content || draft.feedback}</p>
          {!mutation.unresolved && (
            <button className="cb-button" onClick={() => state.setDraft(null)}>
              Discard unsent draft
            </button>
          )}
        </details>
      )}
      {snapshot && (
        <FulfillmentForm
          publisher={publisher}
          snapshot={snapshot}
          draft={draft}
          blocked={
            !canWrite ||
            state.loading ||
            !!state.error ||
            mutation.unresolved ||
            outdated
          }
          busy={mutation.busy}
          frozen={mutation.unresolved}
          reviewed={reviewed}
          setReviewed={setReviewed}
          edit={state.edit}
          submit={(operation) => void submit(operation)}
        />
      )}
      {!canWrite && m.state !== "accepted" && (
        <p className="cb-fine">
          Submissions and reviews require confirmed funding, an active account,
          and current campus email verification. Leaving a team does not remove
          you from this agreement.
        </p>
      )}
    </article>
  );
}
