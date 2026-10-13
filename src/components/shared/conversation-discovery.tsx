"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Feedback, Field } from "./ui";
import {
  conversationRole,
  type ConversationMessage,
  type ConversationScope,
} from "./conversation-types";
import type { BeginDiscoveryAuthority } from "./conversation-state";
import { useConversationDiscovery } from "./conversation-discovery-state";

function MessageText({ message }: { message: ConversationMessage }) {
  return (
    <>
      <div className="cb-row">
        <strong>
          {message.author?.displayName ?? "Author unavailable"}
          {message.author && (
            <span className="cb-message-role">
              {conversationRole(message.author.role)}
            </span>
          )}
        </strong>
        <time dateTime={message.createdAt}>
          {new Date(message.createdAt).toLocaleString("en-US")}
        </time>
      </div>
      <p className="cb-prewrap">{message.body}</p>
    </>
  );
}
export function ConversationDiscovery({
  accountId,
  revision,
  scope,
  id,
  invalidate,
  beginAuthority,
  returnToHistory,
}: {
  accountId: string;
  revision: number;
  scope: ConversationScope;
  id: string;
  invalidate: () => void;
  beginAuthority?: BeginDiscoveryAuthority;
  returnToHistory: () => void;
}) {
  const discovery = useConversationDiscovery(
    accountId,
    scope,
    id,
    invalidate,
    beginAuthority,
  );
  const { search, context, find, select, clearSearch, clearContext } =
    discovery;
  const [query, setQuery] = useState("");
  const [validation, setValidation] = useState<Error | null>(null);
  const input = useRef<HTMLInputElement>(null),
    selected = useRef<HTMLLIElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const params = useSearchParams();
  const messageId = params.get("messageId");
  useEffect(() => {
    clearSearch();
  }, [clearSearch, revision]);
  useEffect(() => {
    if (messageId) void select(messageId);
    else clearContext();
  }, [messageId, select, clearContext, clearSearch, revision]);
  useEffect(() => {
    if (!context.data) return;
    const frame = requestAnimationFrame(() => {
      selected.current?.focus({ preventScroll: true });
      selected.current?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [context.data]);
  function navigate(next: string | null) {
    clearContext();
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("messageId", next);
    else url.searchParams.delete("messageId");
    // Next integrates native history with useSearchParams. No remount or scroll reset.
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
    if (next === messageId && next) void select(next);
  }
  function close() {
    navigate(null);
    if (returnFocus.current?.isConnected)
      returnFocus.current.focus({ preventScroll: true });
    else returnToHistory();
  }
  function clear() {
    clearSearch();
    setQuery("");
    setValidation(null);
    navigate(null);
    input.current?.focus({ preventScroll: true });
  }
  return (
    <div className="cb-discovery">
      <form
        role="search"
        aria-label="Search this conversation"
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          if (!q || [...q].length > 160 || q.includes("\0")) {
            clearSearch();
            setValidation(
              new Error("Enter 1–160 characters to search this conversation."),
            );
            input.current?.focus();
            return;
          }
          setValidation(null);
          void find(q);
        }}
      >
        <Field
          label="Search this conversation"
          help="Search the full message history in this conversation. Matches are literal text, newest first."
        >
          <input
            ref={input}
            type="search"
            value={query}
            aria-invalid={!!validation}
            onChange={(e) => {
              setQuery(e.target.value);
              setValidation(null);
              clearSearch();
            }}
          />
        </Field>
        <div className="cb-team-actions">
          <button className="cb-button" type="submit">
            Search messages
          </button>
          <button className="cb-button" type="button" onClick={clear}>
            Clear search
          </button>
        </div>
      </form>
      <Feedback error={validation || search.error} />
      <p role="status" className="cb-fine">
        {search.busy
          ? "Searching conversation…"
          : search.data
            ? search.data.items.length
              ? `${search.data.items.length} matching messages shown for “${search.data.q}”.${search.data.nextCursor ? " More matches are available." : " No more matches."}`
              : `No messages match “${search.data.q}”.`
            : ""}
      </p>
      {search.data && (
        <section aria-label="Search results">
          <h3>Search results</h3>
          <ol
            className="cb-messages cb-search-results"
            aria-label="Matching messages"
            aria-busy={search.busy}
          >
            {search.data.items.map((m) => (
              <li key={m.id} data-search-message-id={m.id}>
                <MessageText message={m} />
                <button
                  className="cb-button"
                  onClick={(e) => {
                    returnFocus.current = e.currentTarget;
                    navigate(m.id);
                  }}
                >
                  Open message in context
                </button>
              </li>
            ))}
          </ol>
          {search.data.nextCursor && (
            <button
              className="cb-button"
              disabled={search.busy}
              onClick={() => void find(search.data!.q, search.data!)}
            >
              Load more matching messages
            </button>
          )}
          <button
            className="cb-button"
            onClick={() => {
              clear();
              returnToHistory();
            }}
          >
            Return to conversation
          </button>
        </section>
      )}
      {messageId && (
        <section
          className="cb-message-context"
          aria-label="Selected message context"
          aria-busy={context.busy}
        >
          <div className="cb-row">
            <h3>Selected message</h3>
            <button className="cb-button" onClick={close}>
              Close message context
            </button>
          </div>
          <p className="cb-fine">
            Up to 10 messages before and 10 after the selected message. This is
            a limited context window; your loaded conversation history is
            unchanged below.
          </p>
          {context.busy && <p role="status">Loading selected message…</p>}
          <Feedback error={context.error} />
          {context.error && (
            <button
              className="cb-button"
              onClick={() => void select(messageId)}
            >
              Retry selected message
            </button>
          )}
          {context.data && (
            <>
              {context.data.hasOlder && (
                <p className="cb-fine">
                  More messages exist before this context window. Use the
                  conversation history or search to find them.
                </p>
              )}
              <ol className="cb-messages" aria-label="Surrounding messages">
                {[
                  ...context.data.older,
                  context.data.message,
                  ...context.data.newer,
                ].map((m) => {
                  const chosen = m.id === context.data!.message.id;
                  return (
                    <li
                      key={m.id}
                      ref={chosen ? selected : undefined}
                      tabIndex={chosen ? -1 : undefined}
                      data-context-message-id={m.id}
                      aria-current={chosen ? "true" : undefined}
                    >
                      {chosen && (
                        <p className="cb-selected-label">Selected message</p>
                      )}
                      <MessageText message={m} />
                    </li>
                  );
                })}
              </ol>
              {context.data.hasNewer && (
                <p className="cb-fine">
                  More messages exist after this context window. Use the
                  conversation history or search to find them.
                </p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
