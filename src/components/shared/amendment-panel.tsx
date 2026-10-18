"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, request } from "./api";
import { Feedback } from "./ui";
import { useAmendmentRequest } from "./amendment-request";
import { selectAmendmentAnchor } from "./amendment-anchor";
import { decisionBody } from "./amendment-model";
import { AmendmentDetail } from "./amendment-detail";
import { AmendmentEditor } from "./amendment-editor";
import { AmendmentEvents, AmendmentHistory } from "./amendment-history";
import type { Account, Agreement } from "./types";
import type { Amendment, AmendmentOperation } from "./amendment-types";
export function AmendmentPanel({
  agreement,
  account,
  reload,
}: {
  agreement: Agreement;
  account: Account;
  reload: () => void;
}) {
  const params = useSearchParams(),
    requested = params.get("amendmentId"),
    revision = params.get("proposalRevision");
  const [selection, setSelection] = useState<{
      id: string;
      revision?: number;
    } | null>(null),
    [proposal, setProposal] = useState<Amendment | null>(null),
    [editor, setEditor] = useState<"create" | "revise" | null>(null),
    [error, setError] = useState<Error | null>(null),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [conflict, setConflict] = useState(false),
    [denied, setDenied] = useState(false);
  const mutation = useAmendmentRequest(account.id, agreement.id),
    generation = useRef(0),
    opener = useRef<HTMLElement | null>(null);
  const select = useCallback((id: string, rev?: number) => {
    setSelection({ id, revision: rev });
  }, []);
  useEffect(() => {
    if (
      requested &&
      /^[a-f0-9-]{36}$/i.test(requested) &&
      revision &&
      /^[1-9]\d*$/.test(revision)
    )
      select(requested, Number(revision));
    else if (agreement.amendmentSummary) select(agreement.amendmentSummary.id);
  }, [requested, revision, agreement.amendmentSummary?.id, select]);
  const fetchSelected = useCallback(async () => {
    if (!selection) return;
    const turn = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const me = await request<Account>("me");
      if (me.id !== account.id)
        throw new ApiError("Account changed. Sign in again.", 403);
      const p = await request<Amendment>(
        `agreements/${agreement.id}/amendments/${selection.id}${selection.revision ? `?proposalRevision=${selection.revision}` : ""}`,
      );
      if (turn === generation.current) {
        setProposal(p);
        setDenied(false);
      }
    } catch (cause) {
      if (turn === generation.current) {
        setError(cause as Error);
        setProposal(null);
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
          setDenied(true);
      }
    } finally {
      if (turn === generation.current) setLoading(false);
    }
  }, [selection, account.id, agreement.id]);
  useEffect(() => {
    void fetchSelected();
    return () => {
      generation.current++;
    };
  }, [
    fetchSelected,
    refresh,
    agreement.effectiveTerms?.id,
    agreement.amendmentSummary?.proposalRevision,
  ]);
  useEffect(() => {
    const e = mutation.error;
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      setDenied(true);
      setProposal(null);
      setEditor(null);
      reload();
    }
    if (e instanceof ApiError && e.status === 409) {
      setConflict(true);
      if (selection) setSelection({ id: selection.id });
      setRefresh((n) => n + 1);
      reload();
    }
  }, [mutation.error, reload]);
  async function send(
    op?: AmendmentOperation,
    body?: Record<string, unknown>,
    done?: () => void,
  ) {
    setNotice("");
    const result = await mutation.send(
      op,
      body,
      op === "propose" ? undefined : proposal?.id,
    );
    if (result) {
      done?.();
      setEditor(null);
      setConflict(false);
      setNotice(
        `Verified ${result.receipt.operation} receipt for proposal revision ${result.receipt.proposalRevision}. Recorded outcome: ${result.receipt.outcomeAtCommit.replaceAll("_", " ")}. This is not a payment receipt.`,
      );
      select(result.receipt.amendmentId, result.receipt.proposalRevision);
      setRefresh((n) => n + 1);
      reload();
    }
  }
  function open(mode: "create" | "revise") {
    opener.current = document.activeElement as HTMLElement;
    setEditor(mode);
  }
  function close() {
    setEditor(null);
    requestAnimationFrame(() => opener.current?.focus());
  }
  const allowedCreate =
    agreement.agreementAmendments &&
    ["active", "awaiting_funding"].includes(agreement.state) &&
    !agreement.amendmentSummary &&
    account.account_status === "active" &&
    account.campus_verified;
  if (denied)
    return (
      <section className="cb-panel">
        <h2>Changes unavailable</h2>
        <p>
          This agreement or revision is unavailable for the current account.
        </p>
        <Feedback error={error ?? mutation.error} />
      </section>
    );
  return (
    <section className="cb-amendments">
      <h2>Changes and history</h2>
      <Feedback error={mutation.error ?? error} notice={notice} />
      {!agreement.agreementAmendments && (
        <p className="cb-alert">
          Agreement changes are unavailable in this environment. Existing work
          and recorded history remain governed by the current terms.
        </p>
      )}
      {mutation.phase === "sending" && (
        <p role="status">Saving exact proposal request… Editing is paused.</p>
      )}
      {mutation.phase === "unknown" && (
        <div className="cb-alert" role="alert">
          <h3>Request outcome not confirmed</h3>
          <p>
            The exact path, body and request key are saved for this account.
            Recover it before editing or taking another action.
          </p>
          <button className="cb-button" onClick={() => void send()}>
            Recover request
          </button>
        </div>
      )}
      <button
        className="cb-button"
        disabled={loading || mutation.phase === "sending"}
        onClick={() => {
          setRefresh((n) => n + 1);
          reload();
          if (!editor) setConflict(false);
        }}
      >
        Refresh changes
      </button>
      {allowedCreate && !editor && (
        <button
          className="cb-button cb-primary"
          disabled={mutation.blocked}
          onClick={() => open("create")}
        >
          Start a new proposal
        </button>
      )}
      {conflict && !editor && (
        <p className="cb-alert" role="alert">
          This action used an older version. Current history has been loaded.
          Use Refresh changes, review the selected revision, and explicitly
          choose your action again.
        </p>
      )}
      {editor && agreement.effectiveTerms && (
        <AmendmentEditor
          key={`${account.id}:${agreement.id}:${editor === "revise" ? proposal?.id : "create"}`}
          account={account}
          agreement={agreement}
          proposal={editor === "revise" ? (proposal ?? undefined) : undefined}
          blocked={
            mutation.blocked || loading || !agreement.agreementAmendments
          }
          conflict={conflict}
          publish={(body, done) =>
            void send(editor === "create" ? "propose" : "revise", body, done)
          }
          close={close}
        />
      )}
      {loading && <p role="status">Loading exact proposal revision…</p>}
      {proposal && !editor && (
        <>
          <AmendmentDetail
            key={`${proposal.id}:${proposal.proposalRevision}:${refresh}`}
            proposal={proposal}
            disabled={mutation.blocked || loading || conflict}
            revise={() => open("revise")}
            act={(op, reason) =>
              void send(op, {
                ...decisionBody(proposal),
                ...(reason ? { reason } : {}),
              })
            }
          />
          <AmendmentEvents
            key={`${account.id}:${proposal.id}`}
            agreement={agreement.id}
            proposal={proposal.id}
            account={account.id}
            refresh={refresh}
            select={(id, rev) => {
              selectAmendmentAnchor(id, rev);
              select(id, rev);
            }}
          />
        </>
      )}
      {agreement.effectiveTerms && (
        <AmendmentHistory
          account={account.id}
          agreement={agreement.id}
          refresh={refresh}
          select={(id, rev) => {
            selectAmendmentAnchor(id, rev);
            select(id, rev);
          }}
        />
      )}
    </section>
  );
}
