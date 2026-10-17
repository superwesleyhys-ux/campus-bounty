"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
type Pending = { path: string; body: unknown; key: string };
// Scope includes actor + exact resource. Persist before sending; ambiguous results
// freeze the original body/key across refresh, navigation and process loss.
export function useListingRequest<T>(scope: string) {
  const storage = `campus:listing-request:${scope}`;
  const [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [result, setResult] = useState<T | null>(null);
  const active = useRef(true),
    running = useRef(false);
  useEffect(() => {
    active.current = true;
    try {
      const p = JSON.parse(localStorage.getItem(storage) || "null");
      if (
        p &&
        typeof p.path === "string" &&
        typeof p.key === "string" &&
        p.body
      )
        setPending(p);
    } catch {}
    setReady(true);
    return () => {
      active.current = false;
    };
  }, [storage]);
  async function send(path: string, body: unknown) {
    if (running.current || !ready) return;
    const p = pending || { path, body, key: crypto.randomUUID() };
    running.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setPending(p);
    try {
      try {
        localStorage.setItem(storage, JSON.stringify(p));
      } catch {
        /* Keep the exact in-memory request when optional storage is unavailable. */
      }
      const value = await request<T>(p.path, {
        method: "POST",
        body: JSON.stringify(p.body),
        headers: { "Idempotency-Key": p.key },
      });
      const receipt = value as {
        receipt?: { id?: unknown };
        replayed?: unknown;
        current?: unknown;
      };
      if (
        !receipt ||
        typeof receipt.receipt?.id !== "string" ||
        typeof receipt.replayed !== "boolean" ||
        !receipt.current ||
        typeof receipt.current !== "object"
      )
        throw Error(
          "The save response could not be verified. Recover the original request before continuing.",
        );
      try {
        localStorage.removeItem(storage);
      } catch {}
      if (active.current) {
        setPending(null);
        setResult(value);
      }
      return active.current ? value : undefined;
    } catch (e) {
      if (active.current) {
        setError(e as Error);
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          try {
            localStorage.removeItem(storage);
          } catch {}
          setPending(null);
        }
      }
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  return {
    pending,
    busy,
    ready,
    error,
    result,
    send,
    clear: () => {
      setError(null);
      setResult(null);
    },
  };
}
