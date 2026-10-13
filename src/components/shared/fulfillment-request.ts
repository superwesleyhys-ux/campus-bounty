"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, mutationKey, request } from "./api";
import type { FulfillmentResult } from "./fulfillment-types";
type Pending = {
  path: string;
  body: Record<string, unknown>;
  key: string;
  storage: string;
};
// Session-only draft/request recovery is scoped to account and milestone. No credentials are stored.
export function useFulfillmentRequest(scope: string, resource: string) {
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
    try {
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
      const result = await request<FulfillmentResult>(frozen.path, {
        method: "POST",
        body: JSON.stringify(frozen.body),
        headers: { "Idempotency-Key": frozen.key },
      });
      const operation = frozen.path.endsWith("/submissions")
        ? "submit"
        : frozen.path.endsWith("/revision-requests")
          ? "revision_requested"
          : frozen.path.endsWith("/acceptance")
            ? "accepted"
            : "completed";
      if (
        !result?.agreement?.id ||
        result.receipt?.operation !== operation ||
        (operation !== "completed" &&
          (result.milestone?.id !== resource ||
            !Number.isInteger(result.milestone?.revision) ||
            typeof result.receipt.submissionId !== "string"))
      )
        throw new Error(
          "The response could not be verified. Retry the same request to obtain its receipt.",
        );
      clear();
      setPhase("idle");
      return { result, body: frozen.body, recovered };
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause
          : new Error("The request could not be checked."),
      );
      const definitive =
        cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (definitive) clear();
      setPhase(definitive ? "idle" : "unknown");
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
