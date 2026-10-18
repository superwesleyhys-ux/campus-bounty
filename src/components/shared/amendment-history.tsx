"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import { Feedback } from "./ui";
import { TermsView } from "./amendment-comparison";
import type {
  Amendment,
  AmendmentEvent,
  AmendmentPage,
  TermsSnapshot,
} from "./amendment-types";
function usePages<T>(path: string, account: string, refresh: number) {
  const [items, setItems] = useState<T[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<Error | null>(null);
  const generation = useRef(0),
    busy = useRef(false);
  const load = useCallback(
    async (next?: string) => {
      if (busy.current) return;
      busy.current = true;
      const turn = generation.current;
      setLoading(true);
      setError(null);
      try {
        const me = await request<{ id: string }>("me");
        if (me.id !== account) throw new ApiError("Account changed.", 403);
        const page = await request<AmendmentPage<T>>(
          `${path}?limit=5${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (turn !== generation.current) return;
        setItems((old) => (next ? [...old, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (cause) {
        if (turn === generation.current) {
          setError(cause as Error);
          if (
            cause instanceof ApiError &&
            [401, 403, 404].includes(cause.status)
          )
            setItems([]);
        }
      } finally {
        busy.current = false;
        if (turn === generation.current) setLoading(false);
      }
    },
    [path, account],
  );
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setItems([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load, refresh]);
  return {
    items,
    cursor,
    loading,
    error,
    more: () => void load(cursor ?? undefined),
  };
}
export function AmendmentHistory({
  agreement,
  account,
  refresh,
  select,
}: {
  agreement: string;
  account: string;
  refresh: number;
  select: (id: string, rev: number) => void;
}) {
  const proposals = usePages<Amendment>(
    `agreements/${agreement}/amendments`,
    account,
    refresh,
  );
  const terms = usePages<TermsSnapshot>(
    `agreements/${agreement}/terms`,
    account,
    refresh,
  );
  return (
    <section className="cb-panel">
      <h3>Changes and terms history</h3>
      <Feedback error={proposals.error ?? terms.error} />
      {proposals.loading && <p role="status">Loading change history…</p>}
      {!proposals.loading && !proposals.items.length && !proposals.error && (
        <p>No proposals recorded.</p>
      )}
      <ul>
        {proposals.items.map((a) => (
          <li key={a.id}>
            <button
              className="cb-button"
              onClick={() => select(a.id, a.proposalRevision)}
            >
              Open proposal revision {a.proposalRevision}: {a.reason}
            </button>
            <p>{a.status.replaceAll("_", " ")}</p>
          </li>
        ))}
      </ul>
      {(proposals.cursor || proposals.error) && (
        <button
          className="cb-button"
          disabled={proposals.loading}
          onClick={proposals.more}
        >
          Load more proposals
        </button>
      )}
      <details>
        <summary>Terms snapshots</summary>
        {terms.loading && <p role="status">Loading terms…</p>}
        {terms.items.map((t) => (
          <details key={t.id}>
            <summary>
              Terms {t.revision} · {t.origin.replaceAll("_", " ")}
            </summary>
            <TermsView value={t} label="Recorded snapshot" />
            {t.amendmentId && (
              <button
                className="cb-button"
                onClick={() => select(t.amendmentId!, t.proposalRevision!)}
              >
                Open exact proposal revision {t.proposalRevision}
              </button>
            )}
          </details>
        ))}
        {(terms.cursor || terms.error) && (
          <button
            className="cb-button"
            disabled={terms.loading}
            onClick={terms.more}
          >
            Load more terms
          </button>
        )}
      </details>
    </section>
  );
}
export function AmendmentEvents({
  agreement,
  proposal,
  account,
  refresh,
  select,
}: {
  agreement: string;
  proposal: string;
  account: string;
  refresh: number;
  select: (id: string, rev: number) => void;
}) {
  const events = usePages<AmendmentEvent>(
    `agreements/${agreement}/amendments/${proposal}/events`,
    account,
    refresh,
  );
  return (
    <details>
      <summary>Proposal events and earlier revisions</summary>
      <Feedback error={events.error} />
      {events.loading && <p role="status">Loading events…</p>}
      <ol>
        {events.items.map((e) => (
          <li key={e.id}>
            <button
              className="cb-button"
              onClick={() => select(proposal, e.proposalRevision)}
            >
              Revision {e.proposalRevision}: {e.operation.replaceAll("_", " ")}
            </button>
            <p>
              {e.newStatus.replaceAll("_", " ")}
              {e.reason ? ` · ${e.reason}` : ""}
            </p>
            <time dateTime={e.occurredAt}>
              {new Date(e.occurredAt).toLocaleString("en-US")}
            </time>
          </li>
        ))}
      </ol>
      {(events.cursor || events.error) && (
        <button
          className="cb-button"
          disabled={events.loading}
          onClick={events.more}
        >
          Load more events
        </button>
      )}
    </details>
  );
}
