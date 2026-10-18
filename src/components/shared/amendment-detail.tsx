"use client";
import { useEffect, useRef, useState } from "react";
import type { Amendment, AmendmentOperation } from "./amendment-types";
import { AmendmentComparison } from "./amendment-comparison";
import { Field, Status } from "./ui";
import { money } from "./types";
export function AmendmentDetail({
  proposal,
  disabled,
  act,
  revise,
}: {
  proposal: Amendment;
  disabled: boolean;
  act: (op: AmendmentOperation, reason?: string) => void;
  revise: () => void;
}) {
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    setConfirmed(false);
    setReason("");
    const hash = `amendment-${proposal.id}-revision-${proposal.proposalRevision}`;
    if (window.location.hash === `#${hash}`) {
      root.current?.focus({ preventScroll: true });
      root.current?.scrollIntoView({ block: "start" });
    }
  }, [proposal.id, proposal.proposalRevision]);
  return (
    <article
      className="cb-panel"
      ref={root}
      tabIndex={-1}
      id={`amendment-${proposal.id}-revision-${proposal.proposalRevision}`}
    >
      <h3>Proposal revision {proposal.proposalRevision}</h3>
      <Status value={proposal.status} />
      {proposal.proposalRevision !== proposal.currentProposalRevision && (
        <p className="cb-alert">
          Historical revision {proposal.proposalRevision}. Current revision is{" "}
          {proposal.currentProposalRevision}. Confirmations below belong only to
          this selected revision.
        </p>
      )}
      <p className="cb-prewrap">Reason: {proposal.reason}</p>
      {proposal.terminalReason && (
        <p className="cb-prewrap">Closed reason: {proposal.terminalReason}</p>
      )}
      {proposal.status === "agreed_waiting_funds" && (
        <p className="cb-alert" role="status">
          All parties agreed to this change, but it is waiting for funds
          reconciliation and is not effective. Current effective terms still
          govern work. Review the separate financial plan below for actual
          shortfall, personal consent, payment and activation status.
        </p>
      )}
      <AmendmentComparison
        base={proposal.baseTerms}
        proposed={proposal.proposedTerms}
      />
      <h4>Each original party confirms individually</h4>
      <ul className="cb-amendment-people">
        {proposal.participants.map((p) => (
          <li key={p.userId}>
            <strong>{p.displayName || p.userId}</strong> · {p.role}
            {p.userId === proposal.proposerId ? " · Proposal author" : ""}
            <p>
              {p.confirmation
                ? `Confirmed revision ${p.confirmation.proposalRevision}`
                : "Not yet confirmed"}
            </p>
          </li>
        ))}
      </ul>
      {proposal.blockedReasons.length > 0 && (
        <p className="cb-fine">
          Actions unavailable:{" "}
          {proposal.blockedReasons
            .map((s) => s.replaceAll("_", " "))
            .join(", ")}
          .
        </p>
      )}
      {proposal.allowedActions.confirm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed) act("confirm");
          }}
        >
          <label className="cb-check">
            <input
              required
              type="checkbox"
              disabled={disabled}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed proposal revision {proposal.proposalRevision}, terms{" "}
            {proposal.proposedTerms.revision}, reward{" "}
            {money(proposal.proposedTerms.terms.rewardCents)} and target date{" "}
            {proposal.proposedTerms.terms.dueDate || "not specified"}.
          </label>
          <button
            className="cb-button cb-primary"
            disabled={disabled || !confirmed}
          >
            Confirm this revision
          </button>
        </form>
      )}
      {proposal.allowedActions.revise && (
        <button className="cb-button" disabled={disabled} onClick={revise}>
          Revise proposal
        </button>
      )}
      {(proposal.allowedActions.reject || proposal.allowedActions.withdraw) && (
        <fieldset disabled={disabled}>
          <legend>Close this proposal</legend>
          <Field label="Reason to reject or withdraw">
            <textarea
              maxLength={10000}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {proposal.allowedActions.reject && (
            <button
              className="cb-button"
              disabled={!reason.trim()}
              onClick={() => act("reject", reason.trim())}
            >
              Reject proposal
            </button>
          )}
          {proposal.allowedActions.withdraw && (
            <button
              className="cb-button"
              disabled={!reason.trim()}
              onClick={() => act("withdraw", reason.trim())}
            >
              Withdraw proposal
            </button>
          )}
        </fieldset>
      )}
    </article>
  );
}
