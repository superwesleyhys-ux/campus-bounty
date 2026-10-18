"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, mutationKey, request } from "./api";
import type {
  Amendment,
  AmendmentOperation,
  AmendmentResult,
} from "./amendment-types";
import {
  amendmentPath,
  verifyAmendmentReceipt,
  type Pending,
} from "./amendment-receipt";
export function useAmendmentRequest(account: string, agreement: string) {
  const saved = `campus:amendment-request:${account}:${agreement}`;
  const pending = useRef<Pending | null>(null),
    running = useRef(false),
    generation = useRef(0);
  const [phase, setPhase] = useState<
    "loading" | "idle" | "sending" | "unknown"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    generation.current++;
    pending.current = null;
    try {
      const p = JSON.parse(sessionStorage.getItem(saved) || "null");
      if (
        p &&
        p.account === account &&
        p.agreement === agreement &&
        p.path === amendmentPath(agreement, p.operation, p.proposal) &&
        p.key &&
        p.body
      )
        pending.current = p;
    } catch {}
    setPhase(pending.current ? "unknown" : "idle");
    return () => {
      generation.current++;
    };
  }, [saved, account, agreement]);
  function clear() {
    try {
      sessionStorage.removeItem(saved);
      if (pending.current) sessionStorage.removeItem(pending.current.storage);
    } catch {}
    pending.current = null;
  }
  async function send(
    operation?: AmendmentOperation,
    body?: Record<string, unknown>,
    proposal?: string,
  ) {
    if (
      running.current ||
      phase === "loading" ||
      (!pending.current && (!operation || !body))
    )
      return;
    const turn = generation.current;
    running.current = true;
    setPhase("sending");
    setError(null);
    // Identity/history failures never settle an unresolved command; only its POST can.
    let stage: "identity" | "mutation" | "verification" = "identity";
    try {
      // Authentication is checked before both new intents and exact recovery; another tab may have switched accounts.
      const me = await request<{ id: string }>("me");
      if (me.id !== account)
        throw new ApiError(
          "Your account changed. Sign in again to continue.",
          403,
          "account_changed",
        );
      const path = amendmentPath(agreement, operation!, proposal);
      const p = pending.current ?? {
        account,
        agreement,
        path,
        operation: operation!,
        proposal,
        body: structuredClone(body!),
        ...(await mutationKey(account, path, "POST", body)),
      };
      if (turn !== generation.current) return;
      pending.current = p;
      try {
        sessionStorage.setItem(saved, JSON.stringify(p));
      } catch {}
      stage = "mutation";
      const result = await request<AmendmentResult>(p.path, {
        method: "POST",
        body: JSON.stringify(p.body),
        headers: { "Idempotency-Key": p.key },
      });
      stage = "verification";
      verifyAmendmentReceipt(result, p);
      if (["propose", "revise"].includes(p.operation)) {
        const r = result.receipt;
        const exact = await request<Amendment>(
          `agreements/${agreement}/amendments/${r.amendmentId}?proposalRevision=${r.proposalRevision}`,
        );
        const terms = p.body.terms as {
          milestones: Record<string, unknown>[];
          retireMilestoneIds: string[];
          [key: string]: unknown;
        };
        const mappings = r.newMilestoneIds ?? [];
        const stages = terms.milestones.map((m) => {
          if (m.id) return m;
          const mapped = mappings.find(
            (v) => v.clientReference === m.clientReference,
          );
          const { clientReference: _reference, ...rest } = m;
          return { ...rest, id: mapped?.id, position: mapped?.position };
        });
        const same = (a: unknown, b: unknown) =>
          JSON.stringify(a) === JSON.stringify(b);
        if (
          exact.agreementId !== agreement ||
          exact.proposedTerms.id !== r.termsId ||
          exact.proposedTerms.revision !== r.termsRevision ||
          exact.baseTerms.id !== p.body.expectedEffectiveTermsId ||
          exact.baseTerms.revision !== p.body.expectedEffectiveRevision ||
          exact.reason !== p.body.reason ||
          [
            "taskTitle",
            "description",
            "dueDate",
            "rewardCents",
            "currency",
          ].some(
            (k) =>
              (exact.proposedTerms.terms as Record<string, unknown>)[k] !==
              terms[k],
          ) ||
          !same(
            exact.retiredMilestoneIds.slice().sort(),
            terms.retireMilestoneIds.slice().sort(),
          ) ||
          stages.length !== exact.proposedTerms.milestones.length ||
          stages.some((m) => {
            const actual = exact.proposedTerms.milestones.find(
              (s) => s.id === m.id,
            );
            return (
              !actual ||
              Object.entries(m).some(
                ([key, v]) =>
                  (actual as unknown as Record<string, unknown>)[key] !== v,
              )
            );
          })
        )
          throw new Error(
            "Historical proposal receipt does not match the frozen intent. Recover the same request.",
          );
      }
      if (turn !== generation.current) return;
      clear();
      setPhase("idle");
      return result;
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.code === "account_changed")
      )
        window.dispatchEvent(new Event("campus:session-expired"));
      if (turn !== generation.current) return;
      const e =
        cause instanceof Error ? cause : new Error("Could not check request.");
      setError(e);
      const definite =
        stage === "mutation" &&
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500;
      if (definite) clear();
      setPhase(pending.current ? "unknown" : "idle");
    } finally {
      running.current = false;
    }
  }
  return { send, phase, error, blocked: phase !== "idle" };
}
