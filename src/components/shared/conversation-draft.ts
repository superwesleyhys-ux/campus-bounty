"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { Account, Message } from "./types";
import type { ConversationScope } from "./conversation-types";

type Saved = { body: string; pending: null | { body: string; key: string } };
// Session-local fallback also survives route changes when browser storage fails.
// Entries are keyed by both authenticated account and exact conversation.
const memory = new Map<string, Saved>();
export function useConversationDraft(
  accountId: string,
  scope: ConversationScope,
  id: string,
) {
  const storage = `campus:conversation:${accountId}:${scope}:${id}`;
  const value = useRef<Saved>({ body: "", pending: null });
  const [draft, setDraft] = useState<Saved>(value.current);
  const [phase, setPhase] = useState<
    "loading" | "idle" | "sending" | "unknown"
  >("loading");
  const [storageFailed, setStorageFailed] = useState(false);
  const [error, setError] = useState<Error | null>(null),
    [notice, setNotice] = useState("");
  const running = useRef(false),
    active = useRef(false);
  useEffect(() => {
    active.current = true;
    let restored = memory.get(storage);
    try {
      const raw = sessionStorage.getItem(storage);
      if (!restored && raw) {
        const parsed = JSON.parse(raw) as Saved;
        if (
          typeof parsed.body !== "string" ||
          (parsed.pending &&
            (typeof parsed.pending.body !== "string" ||
              !/^[!-~]{8,128}$/.test(parsed.pending.key)))
        )
          throw new Error("Saved draft is unavailable");
        restored = parsed;
      }
      // Probe writes too: read access alone does not establish durable recovery.
      sessionStorage.setItem(
        storage,
        JSON.stringify(restored ?? value.current),
      );
    } catch {
      setStorageFailed(true);
    }
    value.current = restored ?? { body: "", pending: null };
    memory.set(storage, value.current);
    setDraft(value.current);
    setPhase(value.current.pending ? "unknown" : "idle");
    const hide = () => {
      active.current = false;
    };
    const changed = (event: StorageEvent) => {
      if (
        ["campus:auth-version", "campus:account-version"].includes(
          event.key ?? "",
        )
      )
        hide();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("campus:session-expired", hide);
    return () => {
      active.current = false;
      window.removeEventListener("storage", changed);
      window.removeEventListener("campus:session-expired", hide);
    };
  }, [storage]);
  function save(next: Saved) {
    value.current = next;
    memory.set(storage, next);
    if (active.current) setDraft(next);
    try {
      sessionStorage.setItem(storage, JSON.stringify(next));
      if (active.current) setStorageFailed(false);
    } catch {
      if (active.current) setStorageFailed(true);
    }
  }
  function edit(body: string) {
    if (phase !== "idle" || value.current.pending) return;
    save({ body, pending: null });
    setNotice("");
    setError(null);
  }
  async function send() {
    if (!active.current || running.current || phase === "loading") return;
    if (!value.current.pending && !value.current.body.trim()) return;
    const recovering = !!value.current.pending;
    const frozen = value.current.pending ?? {
      body: value.current.body,
      key: crypto.randomUUID(),
    };
    save({ body: frozen.body, pending: frozen });
    running.current = true;
    setPhase("sending");
    setError(null);
    setNotice("");
    try {
      const me = await request<Account>("me");
      if (!active.current) return;
      if (
        me.id !== accountId ||
        me.account_status !== "active" ||
        !me.campus_verified
      )
        throw new ApiError(
          "Sending is unavailable for this account. The original request remains saved; restore access before recovering it.",
          403,
          "send_access_changed",
        );
      const result = await request<
        Message & {
          agreement_id: string | null;
          order_id: string | null;
          application_id?: string | null;
        }
      >("messages", {
        method: "POST",
        body: JSON.stringify({ [scope]: id, body: frozen.body }),
        headers: { "Idempotency-Key": frozen.key },
      });
      if (
        !result?.id ||
        result.sender_id !== accountId ||
        result.body !== frozen.body.trim() ||
        result[
          scope === "agreementId"
            ? "agreement_id"
            : scope === "applicationId"
              ? "application_id"
              : "order_id"
        ] !== id
      )
        throw new Error(
          "The message receipt could not be verified. Recover the same request to confirm its outcome.",
        );
      save({ body: "", pending: null });
      if (active.current) {
        setPhase("idle");
        setNotice(
          recovering
            ? "Message confirmed. The original request was recovered without sending a duplicate."
            : "Message sent and confirmed.",
        );
      }
      return active.current ? result.id : undefined;
    } catch (cause) {
      // An earlier ambiguous request may already be committed. A later denial,
      // conflict or network failure cannot prove otherwise; retain its exact key.
      const correctable =
        !recovering &&
        cause instanceof ApiError &&
        cause.status === 422 &&
        cause.code === "invalid_input";
      // Only this typed application refusal proves that no receipt exists for
      // the exact key, including when recovering a previously ambiguous send.
      const closedWithoutRecord =
        scope === "applicationId" &&
        cause instanceof ApiError &&
        cause.status === 409 &&
        cause.code === "application_conversation_closed";
      if (correctable || closedWithoutRecord)
        save({ body: frozen.body, pending: null });
      if (active.current) {
        setPhase(correctable || closedWithoutRecord ? "idle" : "unknown");
        if (closedWithoutRecord)
          setNotice(
            "Message not sent. This application discussion is closed. Your draft is saved here; it has not been moved or sent elsewhere.",
          );
        setError(
          cause instanceof Error
            ? cause
            : new Error("Message outcome could not be confirmed."),
        );
      }
    } finally {
      running.current = false;
    }
  }
  return { body: draft.body, phase, storageFailed, error, notice, edit, send };
}
