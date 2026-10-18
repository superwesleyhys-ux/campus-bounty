"use client";
import { useState } from "react";
import { useAmendmentDraft } from "./amendment-draft";
import { newAmendmentDraft } from "./amendment-model";
import { AmendmentForm } from "./amendment-form";
import { AmendmentComparison } from "./amendment-comparison";
import type { Account, Agreement } from "./types";
import type { Amendment } from "./amendment-types";
export function AmendmentEditor({
  account,
  agreement,
  proposal,
  blocked,
  conflict,
  publish,
  close,
}: {
  account: Account;
  agreement: Agreement;
  proposal?: Amendment;
  blocked: boolean;
  conflict: boolean;
  publish: (body: Record<string, unknown>, done: () => void) => void;
  close: () => void;
}) {
  const state = useAmendmentDraft(
    account.id,
    agreement.id,
    proposal?.id ?? "create",
  );
  const [acknowledged, setAcknowledged] = useState("");
  if (!state.ready || !agreement.effectiveTerms)
    return <p role="status">Loading saved draft…</p>;
  const draft =
    state.draft ?? newAmendmentDraft(agreement.effectiveTerms, proposal);
  const identity = `${agreement.effectiveTerms.id}:${proposal?.currentProposalRevision ?? 0}:${conflict}`;
  const stale =
    draft.base.id !== agreement.effectiveTerms.id ||
    (proposal && draft.proposalRevision !== proposal.currentProposalRevision) ||
    (conflict && acknowledged !== identity);
  return (
    <>
      {stale && (
        <div className="cb-alert" role="alert">
          <h3>The agreement or proposal changed</h3>
          <p>
            Your edits are retained. Review what changed below before explicitly
            updating the draft preconditions. Review the full proposed
            comparison again before publishing.
          </p>
          <AmendmentComparison
            base={draft.base}
            proposed={agreement.effectiveTerms}
          />
          {proposal && (
            <>
              <h4>
                Current server proposal revision{" "}
                {proposal.currentProposalRevision}
              </h4>
              <AmendmentComparison
                base={draft.base}
                proposed={proposal.proposedTerms}
              />
            </>
          )}
          <p>
            Draft proposal revision: {draft.proposalRevision ?? "new"}; current:{" "}
            {proposal?.currentProposalRevision ?? "new"}.
          </p>
          <button
            className="cb-button"
            disabled={blocked}
            onClick={() => {
              state.setDraft({
                ...draft,
                base: agreement.effectiveTerms!,
                proposalRevision: proposal?.currentProposalRevision,
              });
              setAcknowledged(identity);
            }}
          >
            Keep edits and review current terms
          </button>
        </div>
      )}
      <AmendmentForm
        draft={draft}
        agreement={agreement}
        disabled={blocked || !!stale}
        setDraft={state.setDraft}
        publish={(body) => publish(body, () => state.setDraft(null))}
        close={close}
      />
    </>
  );
}
