"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

// Keep continuation in the URL so reload, details and browser Back are durable.
export function HistoryPagination({
  count,
  nextCursor,
  loading,
  controlsOnly = false,
}: {
  count?: number;
  nextCursor?: string | null;
  loading: boolean;
  controlsOnly?: boolean;
}) {
  const query = useSearchParams(),
    cursor = query.get("cursor"),
    status = useRef<HTMLParagraphElement>(null);
  const identity = query.toString();
  const lastLoaded = useRef<string | null>(null);
  useEffect(() => {
    if (controlsOnly || loading || count === undefined) return;
    if (lastLoaded.current !== null && lastLoaded.current !== identity) {
      status.current?.focus({ preventScroll: true });
      status.current?.scrollIntoView({ block: "start" });
    }
    lastLoaded.current = identity;
  }, [identity, loading, count, controlsOnly]);
  function page(value: string | null) {
    const p = new URLSearchParams(query.toString());
    p.delete("offset");
    if (value) p.set("cursor", value);
    else p.delete("cursor");
    return `/?${p}`;
  }
  return (
    <div className="cb-history-pagination">
      {!controlsOnly && count !== undefined && (
        <p ref={status} tabIndex={-1} role="status" className="cb-muted">
          {count} {count === 1 ? "record" : "records"} on this page ·{" "}
          {cursor ? "Older records" : "Newest records"}
          {nextCursor ? " · More available" : " · End of list"}
        </p>
      )}
      <nav
        className="cb-pagination"
        aria-label={
          controlsOnly ? "History pages after results" : "History pages"
        }
      >
        {cursor && (
          <Link className="cb-button" href={page(null)}>
            ← Back to newest
          </Link>
        )}
        {!loading && nextCursor && (
          <Link className="cb-button" href={page(nextCursor)}>
            Next page →
          </Link>
        )}
      </nav>
    </div>
  );
}

export function historyDetailUrl(
  query: { toString(): string },
  view: string,
  id: string,
  resource?: string,
) {
  const p = new URLSearchParams(query.toString());
  p.set("returnView", p.get("returnView") || p.get("view") || "workspace");
  p.set("view", view);
  p.set("id", id);
  if (resource) p.set("resource", resource);
  else p.delete("resource");
  return `/?${p}`;
}
