"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import { useVisiblePoll } from "./visible-poll";
import { Feedback, Status } from "./ui";
import type { Account } from "./types";
type Item = {
  id: string;
  type: "application" | "agreement" | "order";
  title: string | null;
  state: string;
  role: string;
  createdAt: string;
};
type Page = { items: Item[]; nextCursor: string | null };
export function Messages({ accountId }: { accountId: string }) {
  const [page, setPage] = useState<Page | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [denied, setDenied] = useState(false),
    [newer, setNewer] = useState(false);
  const generation = useRef(0),
    running = useRef(false),
    newest = useRef<string | null>(null);
  const read = useCallback(
    async (silent = false) => {
      if (running.current) return;
      const token = generation.current;
      running.current = true;
      if (!silent) setBusy(true);
      try {
        const me = await request<Account>("me");
        if (token !== generation.current) return;
        if (me.id !== accountId || me.account_status === "locked")
          throw new ApiError("Account changed. Sign in again.", 403);
        const result = await request<Page>(
          `conversations/inbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        const first = cursor
          ? await request<Page>("conversations/inbox?limit=1")
          : result;
        if (token !== generation.current) return;
        const key = first.items[0]?.id ?? null;
        if (cursor) setNewer(key !== newest.current);
        else {
          newest.current = key;
          setNewer(false);
        }
        setPage(result);
        setError(null);
        setDenied(false);
        return true;
      } catch (cause) {
        if (token !== generation.current) return;
        if (
          cause instanceof ApiError &&
          [401, 403, 404].includes(cause.status)
        ) {
          generation.current++;
          running.current = false;
          setPage(null);
          setDenied(true);
          setBusy(false);
        }
        setError(
          cause instanceof Error
            ? cause
            : new Error("Messages could not be loaded."),
        );
        return false;
      } finally {
        if (token === generation.current) {
          running.current = false;
          setBusy(false);
        }
      }
    },
    [accountId, cursor],
  );
  useEffect(() => {
    generation.current++;
    running.current = false;
    setPage(null);
    void read();
    const clear = () => {
      generation.current++;
      setPage(null);
      setDenied(true);
      setBusy(false);
    };
    const changed = (e: StorageEvent) => {
      if (
        ["campus:auth-version", "campus:account-version"].includes(e.key ?? "")
      )
        clear();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("campus:session-expired", clear);
    return () => {
      generation.current++;
      window.removeEventListener("storage", changed);
      window.removeEventListener("campus:session-expired", clear);
    };
  }, [read]);
  const status = useVisiblePoll(() => read(true), !denied);
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Your private conversations</span>
          <h1>Messages</h1>
        </div>
        <button
          className="cb-button"
          disabled={busy}
          onClick={() => void read()}
        >
          Check messages
        </button>
      </div>
      <p>
        Chat with people in your applications, signed agreements and orders.
        Includes applications received on your bounties. Newest conversations
        first.
      </p>
      <p className="cb-fine" role="status">
        {busy ? "Loading conversations…" : status}
      </p>
      <Feedback error={error} />
      {cursor && (
        <button className="cb-button" onClick={() => setCursor(null)}>
          {newer
            ? "New conversations available · Show newest"
            : "Back to newest conversations"}
        </button>
      )}
      {page?.items.length === 0 && (
        <section className="cb-panel">
          <h2>No conversations yet</h2>
          <p>
            Apply to a bounty or receive an application on your listing to start
            a private discussion.
          </p>
          <Link href="/?view=bounties" className="cb-button">
            Explore bounties
          </Link>
        </section>
      )}
      {page?.items.map((item) => (
        <article className="cb-panel" key={`${item.type}:${item.id}`}>
          <div className="cb-row">
            <h2>
              {item.title ||
                `${item.type[0].toUpperCase()}${item.type.slice(1)} history`}
            </h2>
            <Status value={item.state} />
          </div>
          <p>
            {item.type} · {item.role}
          </p>
          <Link
            className="cb-button cb-primary"
            href={`/?view=workspace&resource=${item.type}&id=${item.id}`}
          >
            Open chat
          </Link>
        </article>
      ))}
      {page && (
        <p className="cb-fine">
          {page.items.length} conversations on this page.
          {page.nextCursor
            ? " More conversations are available."
            : " End of conversations."}
        </p>
      )}
      {page?.nextCursor && (
        <button
          className="cb-button"
          disabled={busy}
          onClick={() => setCursor(page.nextCursor)}
        >
          Older conversations
        </button>
      )}
    </>
  );
}
