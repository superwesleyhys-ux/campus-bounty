"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, mutationKey, request } from "./api";
import type { Submission } from "./types";
import type { MilestoneReview, FulfillmentResult } from "./fulfillment-types";
type Pending = {
  path: string;
  body: Record<string, unknown>;
  key: string;
  storage: string;
};
// Session-only draft/request recovery is scoped to account and milestone. No credentials are stored.
export function useFulfillmentRequest(
  scope: string,
  resource: string,
  agreementId?: string,
) {
  const saved = `campus:fulfillment-request:${scope}:${resource}`;
  const pending = useRef<Pending | null>(null),
    running = useRef(false);
  const [phase, setPhase] = useState<
    "loading" | "idle" | "sending" | "unknown"
  >("loading");
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    pending.current = null;
    try {
      const raw = sessionStorage.getItem(saved);
      if (raw) {
        const value = JSON.parse(raw);
        if (
          typeof value.path === "string" &&
          (value.path.startsWith(`milestones/${resource}/`) ||
            value.path ===
              `agreements/${resource.replace("completion:", "")}/completion`) &&
          typeof value.key === "string" &&
          value.body &&
          value.storage
        )
          pending.current = value;
      }
    } catch {
      /* Optional storage. */
    }
    setPhase(pending.current ? "unknown" : "idle");
  }, [saved]);
  async function send(path?: string, body?: Record<string, unknown>) {
    if (running.current || phase === "loading") return;
    if (!pending.current && (!path || !body)) return;
    const recovered = pending.current !== null;
    running.current = true;
    setPhase("sending");
    setError(null);
    // Identity/history failures never settle an unresolved command; only its POST can.
    let stage: "identity" | "mutation" | "verification" = "identity";
    try {
      const me = await request<{ id: string }>("me");
      if (me.id !== scope)
        throw new ApiError(
          "Your account changed. Sign in again before continuing.",
          403,
          "account_changed",
        );
      const frozen = pending.current ?? {
        path: path!,
        body: body!,
        ...(await mutationKey(scope, path!, "POST", body)),
      };
      pending.current = frozen;
      try {
        sessionStorage.setItem(saved, JSON.stringify(frozen));
      } catch {
        /* In-memory request remains frozen. */
      }
      stage = "mutation";
      const result = await request<FulfillmentResult>(frozen.path, {
        method: "POST",
        body: JSON.stringify(frozen.body),
        headers: { "Idempotency-Key": frozen.key },
      });
      stage = "verification";
      const operation = frozen.path.endsWith("/submissions")
        ? "submit"
        : frozen.path.endsWith("/revision-requests")
          ? "revision_requested"
          : frozen.path.endsWith("/acceptance")
            ? "accepted"
            : "completed";
      if (
        !result?.agreement?.id ||
        (operation === "completed" &&
          result.receipt?.agreementId !==
            resource.replace("completion:", "")) ||
        (agreementId && result.agreement.id !== agreementId) ||
        result.receipt?.operation !== operation ||
        (operation !== "completed" &&
          (result.milestone?.id !== resource ||
            !Number.isInteger(result.milestone?.revision) ||
            typeof result.receipt.submissionId !== "string"))
      )
        throw new Error(
          "The response could not be verified. Retry the same request to obtain its receipt.",
        );
      if (operation !== "completed") {
        const history = await request<Submission[]>(
          `milestones/${resource}/submissions`,
        );
        const historical = history.find(
          (s) => s.id === result.receipt.submissionId,
        );
        const b = frozen.body;
        if (
          !historical ||
          (operation === "submit"
            ? historical.version !== Number(b.expectedVersion) + 1 ||
              historical.content !== b.content
            : historical.id !== b.submissionId ||
              historical.version !== b.expectedVersion) ||
          (b.expectedEffectiveTermsId &&
            (historical.submissionTermsId !== b.expectedEffectiveTermsId ||
              historical.submissionTermsRevision !==
                b.expectedEffectiveRevision)) ||
          (b.submissionTermsId &&
            (historical.submissionTermsId !== b.submissionTermsId ||
              historical.submissionTermsRevision !== b.submissionTermsRevision))
        )
          throw new Error(
            "The exact historical work receipt could not be verified. Retry the same request.",
          );
      }
      if (operation === "accepted" || operation === "revision_requested") {
        const reviews = await request<MilestoneReview[]>(
          `milestones/${resource}/reviews`,
        );
        const exact = reviews.find((r) => r.id === result.receipt.reviewId);
        if (
          !exact ||
          exact.decision !== operation ||
          exact.submission_id !== frozen.body.submissionId ||
          exact.submission_version !== frozen.body.expectedVersion ||
          (operation === "revision_requested" &&
            exact.feedback !== frozen.body.feedback)
        )
          throw new Error(
            "The historical review receipt could not be verified. Retry the same request.",
          );
      }
      clear();
      setPhase("idle");
      return { result, body: frozen.body, recovered };
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.code === "account_changed")
      )
        window.dispatchEvent(new Event("campus:session-expired"));
      setError(
        cause instanceof Error
          ? cause
          : new Error("The request could not be checked."),
      );
      const definitive =
        stage === "mutation" &&
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500;
      if (definitive) clear();
      setPhase(pending.current ? "unknown" : "idle");
    } finally {
      running.current = false;
    }
  }
  function clear() {
    try {
      sessionStorage.removeItem(saved);
      if (pending.current) sessionStorage.removeItem(pending.current.storage);
    } catch {
      /* Optional storage. */
    }
    pending.current = null;
  }
  return {
    send,
    phase,
    error,
    busy: phase === "sending",
    unresolved: phase !== "idle",
  };
}
