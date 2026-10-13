"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { Notification } from "./notification-types";

// Persist only identifiers and random request keys, scoped to the signed-in account.
export function useNotificationRead(accountId: string, confirmed: () => void) {
  const storage = `campus:notification-read:${accountId}`;
  const [pending, setPending] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [error, setError] = useState<Error>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(storage) || "{}");
      keys.current = Object.fromEntries(
        Object.entries(parsed).filter(
          ([id, key]) =>
            /^[a-f0-9-]{36}$/i.test(id) &&
            typeof key === "string" &&
            /^[a-f0-9-]{36}$/i.test(key),
        ),
      ) as Record<string, string>;
      setPending(keys.current);
    } catch {
      /* Recovery storage is optional. */
    }
  }, [storage]);
  function persist(next: Record<string, string>) {
    keys.current = next;
    setPending(next);
    try {
      sessionStorage.setItem(storage, JSON.stringify(next));
    } catch {
      /* The in-memory key still protects retries. */
    }
  }
  async function markRead(id: string) {
    if (running.current) return;
    running.current = true;
    setBusy(id);
    setError(undefined);
    setNotice("");
    const key = keys.current[id] || crypto.randomUUID();
    persist({ ...keys.current, [id]: key });
    const clear = () => {
      const next = { ...keys.current };
      delete next[id];
      persist(next);
    };
    try {
      const result = await request<Notification>(`notifications/${id}/read`, {
        method: "POST",
        body: "{}",
        headers: { "Idempotency-Key": key },
      });
      if (result.id !== id || !result.readAt)
        throw new Error(
          "The read result could not be verified. Retry the same request.",
        );
      clear();
      setNotice("Marked as read. This does not complete any project action.");
      confirmed();
      window.dispatchEvent(new Event("campus:notifications-changed"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause
          : new Error("Could not confirm read status."),
      );
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500
      )
        clear();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }
  return { pending, busy, error, notice, markRead };
}
