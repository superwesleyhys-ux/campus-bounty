import { useRef, useState } from "react";
import { ApiError, mutationKey, request } from "./api";

type FrozenRequest = {
  path: string;
  body: unknown;
  key: string;
  storage: string;
};
export function useTeamRequest(scope: string) {
  const frozen = useRef<FrozenRequest | null>(null);
  const running = useRef(false);
  const [phase, setPhase] = useState<"idle" | "sending" | "unknown">("idle");
  const [error, setError] = useState<Error | null>(null);

  async function send<T>(
    path?: string,
    body?: unknown,
  ): Promise<T | undefined> {
    if (running.current) return;
    // Once sent, the exact request and key remain frozen until resolved.
    if (!frozen.current && !path) return;
    running.current = true;
    setPhase("sending");
    setError(null);
    try {
      const pending = frozen.current ?? {
        path: path!,
        body,
        ...(await mutationKey(scope, path!, "POST", body)),
      };
      frozen.current = pending;
      const result = await request<T>(pending.path, {
        method: "POST",
        body: JSON.stringify(pending.body),
        headers: { "Idempotency-Key": pending.key },
      });
      const team = result as {
        id?: unknown;
        revision?: unknown;
        members?: unknown;
        status?: unknown;
      } | null;
      if (
        !team ||
        typeof team.id !== "string" ||
        !Number.isInteger(team.revision) ||
        !Array.isArray(team.members) ||
        !["active", "archived"].includes(String(team.status))
      ) {
        throw new Error(
          "The server response could not be verified. Check the current state or retry this same request.",
        );
      }
      clearPending();
      setPhase("idle");
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause
          : new Error("The request could not be checked."),
      );
      const definitive =
        cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      if (definitive) clearPending();
      setPhase(definitive ? "idle" : "unknown");
    } finally {
      running.current = false;
    }
  }
  function clearPending() {
    if (frozen.current) {
      try {
        sessionStorage.removeItem(frozen.current.storage);
      } catch {
        /* Storage is optional; in-memory recovery remains available. */
      }
    }
    frozen.current = null;
  }
  function resolve() {
    if (running.current) return;
    clearPending();
    setError(null);
    setPhase("idle");
  }
  return {
    send,
    resolve,
    phase,
    error,
    busy: phase === "sending",
    unresolved: phase !== "idle",
  };
}
