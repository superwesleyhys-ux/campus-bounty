"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "./api";
import { HistoryPagination } from "./history-pagination";
import {
  categories,
  money,
  type Task,
  type Product,
  type PageResult,
  type HistoryPage,
} from "./types";
import { Empty, ResourceState, Status } from "./ui";
import { TargetDeliveryDate } from "./task-terms";

export function Catalog({
  kind,
  openUrl,
  saved = false,
}: {
  kind: "task" | "product";
  openUrl: (id: string) => string;
  saved?: boolean;
}) {
  const query = useSearchParams(),
    router = useRouter(),
    offset = Math.max(0, Number(query.get("offset")) || 0);
  const search = new URLSearchParams({
    limit: "12",
    offset: String(offset),
    q: query.get("q") || "",
    sort: query.get("sort") || "recent",
  });
  if (kind === "task" && query.get("category"))
    search.set("category", query.get("category")!);
  const savedSearch = new URLSearchParams({ scope: "saved" });
  if (query.has("cursor")) savedSearch.set("cursor", query.get("cursor")!);
  const resource = useResource<PageResult<Task | Product> | HistoryPage<Task>>(
    saved
      ? `workspace/history?${savedSearch}`
      : `${kind === "task" ? "tasks" : "products"}?${search}`,
  );
  const items = resource.data?.items;
  const total =
    resource.data && "total" in resource.data ? resource.data.total : undefined;
  function page(value: number) {
    const p = new URLSearchParams(query.toString());
    p.set("offset", String(value));
    return `/?${p}`;
  }
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">
            {saved
              ? "Your shortlist"
              : kind === "task"
                ? "Ideas meet people"
                : "Good things, another chapter"}
          </span>
          <h1>
            {saved
              ? "Saved bounties"
              : kind === "task"
                ? "Find your next collaboration."
                : "The campus marketplace."}
          </h1>
          <p>
            {kind === "task"
              ? "Research, build, write or design. Find a project that fits your skills."
              : "Useful things from your university community. Choose pickup or shipping."}
          </p>
        </div>
        <Link className="cb-button" href={`/?view=publish&kind=${kind}`}>
          {kind === "task" ? "Post a bounty" : "List an item"} →
        </Link>
      </div>
      {!saved && (
        <form
          key={`${query.get("q")}:${query.get("category")}:${query.get("sort")}`}
          className="cb-filters"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const p = new URLSearchParams({
              view: kind === "task" ? "bounties" : "market",
            });
            for (const [key, value] of form)
              if (value) p.set(key, String(value));
            router.push(`/?${p}`);
          }}
        >
          <label>
            Search
            <input
              name="q"
              defaultValue={query.get("q") || ""}
              placeholder={
                kind === "task" ? "Project or keyword" : "Item or keyword"
              }
              maxLength={120}
              type="search"
            />
          </label>
          {kind === "task" && (
            <label>
              Category
              <select
                name="category"
                defaultValue={query.get("category") || ""}
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Sort
            <select name="sort" defaultValue={query.get("sort") || "recent"}>
              <option value="recent">Newest first</option>
              <option value="amount_desc">
                Highest {kind === "task" ? "reward" : "price"}
              </option>
              <option value="amount_asc">
                Lowest {kind === "task" ? "reward" : "price"}
              </option>
            </select>
          </label>
          <button className="cb-button cb-primary">
            Find {kind === "task" ? "bounties" : "items"}
          </button>
          {(query.get("q") || query.get("category")) && (
            <Link
              className="cb-text-button"
              href={`/?view=${kind === "task" ? "bounties" : "market"}`}
            >
              Clear filters
            </Link>
          )}
        </form>
      )}
      <ResourceState {...resource} />
      {saved && (
        <HistoryPagination
          count={items?.length}
          nextCursor={
            resource.data && "nextCursor" in resource.data
              ? resource.data.nextCursor
              : undefined
          }
          loading={resource.loading}
        />
      )}
      {items && (
        <>
          {!saved && (
            <p className="cb-muted" role="status">
              {total ?? items.length} {kind === "task" ? "bounties" : "items"}
              {total ? ` · Showing ${offset + 1}–${offset + items.length}` : ""}
            </p>
          )}
          {!items.length ? (
            <Empty
              title={
                saved && query.has("cursor")
                  ? "No records on this page"
                  : saved
                    ? "Start a shortlist"
                    : "Nothing here yet"
              }
            >
              {saved && query.has("cursor")
                ? "There are no more accessible saved bounties at this position. Return to newest records or use your browser’s Back button."
                : saved
                  ? "Save a bounty from its details to find it here later."
                  : "Try a different search or post the first listing."}
            </Empty>
          ) : (
            <div className={kind === "task" ? "cb-list" : "cb-products"}>
              {items.map((item) => (
                <article className="cb-listing" key={item.id}>
                  {"reward_cents" in item ? (
                    <>
                      <div className="cb-listing-copy">
                        <div className="cb-overline">
                          {item.category} <Status value={item.status} />
                        </div>
                        <h2>
                          <Link href={openUrl(item.id)}>{item.title}</Link>
                        </h2>
                        <p>{item.description}</p>
                        <TargetDeliveryDate value={item.due_date} />
                        <span className="cb-muted">
                          Individual or team applications
                        </span>
                      </div>
                      <div className="cb-reward">
                        <small>Bounty reward</small>
                        <strong>{money(item.reward_cents)}</strong>
                        <Link href={openUrl(item.id)}>View bounty →</Link>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="cb-item-mark" aria-hidden="true">
                        CB / CAMPUS FINDS
                      </div>
                      <h2>
                        <Link href={openUrl(item.id)}>{item.title}</Link>
                      </h2>
                      <p>{item.description}</p>
                      <div className="cb-product-meta">
                        <strong>{money(item.price_cents)}</strong>
                        <span>
                          {item.stock > 0
                            ? `${item.stock} available`
                            : "Out of stock"}
                        </span>
                      </div>
                      <span className="cb-muted">
                        {item.delivery_methods
                          .map((d) =>
                            d === "pickup" ? "Campus pickup" : "U.S. shipping",
                          )
                          .join(" · ")}
                      </span>
                      <Link className="cb-text-button" href={openUrl(item.id)}>
                        View item →
                      </Link>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
          {saved && (
            <HistoryPagination
              controlsOnly
              nextCursor={
                resource.data && "nextCursor" in resource.data
                  ? resource.data.nextCursor
                  : undefined
              }
              loading={resource.loading}
            />
          )}
          {!saved && (
            <nav className="cb-pagination" aria-label="Result pages">
              {offset > 0 && (
                <Link
                  className="cb-button"
                  href={page(Math.max(0, offset - 12))}
                >
                  ← Previous
                </Link>
              )}
              {total !== undefined && offset + items.length < total && (
                <Link className="cb-button" href={page(offset + 12)}>
                  Next →
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </>
  );
}
