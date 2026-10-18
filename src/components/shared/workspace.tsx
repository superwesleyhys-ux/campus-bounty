"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "./api";
import { HistoryPagination, historyDetailUrl } from "./history-pagination";
import { AgreementSummary } from "./agreement-summary";
import { ApplicationCard } from "./application-card";
import {
  money,
  type Account,
  type Application,
  type Agreement,
  type Order,
  type Task,
  type Product,
  type HistoryPage,
} from "./types";
import { Empty, ResourceState, Status } from "./ui";
export { AgreementDetail } from "./agreement-detail";
export { OrderDetail } from "./order-detail";

export function Workspace({ account }: { account: Account }) {
  const query = useSearchParams(),
    router = useRouter(),
    section = [
      "applications",
      "agreements",
      "orders",
      "posted",
      "selling",
    ].includes(query.get("tab") || "")
      ? query.get("tab")!
      : "applications";
  const search = new URLSearchParams({ scope: section });
  if (query.has("cursor")) search.set("cursor", query.get("cursor")!);
  const resource = useResource<
    HistoryPage<Application | Agreement | Order | Task | Product>
  >(`workspace/history?${search}`);
  const items = resource.data?.items;
  const detail = (view: string, id: string, kind?: string) =>
    historyDetailUrl(query, view, id, kind);
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Keep things moving</span>
          <h1>Your workspace</h1>
          <p>Applications, collaborations and campus orders in one place.</p>
        </div>
        <button
          className="cb-button"
          onClick={resource.reload}
          disabled={resource.loading}
        >
          Refresh this page
        </button>
      </div>
      <nav className="cb-tabs" aria-label="Workspace sections">
        {[
          ["applications", "Applications"],
          ["agreements", "Agreements"],
          ["orders", "Orders"],
          ["posted", "My bounties"],
          ["selling", "My listings"],
        ].map(([value, title]) => (
          <Link
            key={value}
            href={`/?view=workspace&tab=${value}`}
            aria-current={section === value ? "page" : undefined}
          >
            {title}
          </Link>
        ))}
      </nav>
      {section === "applications" && !account.can_apply && (
        <p className="cb-alert">
          Ready to take on a bounty?{" "}
          <Link href="/?view=account#student-eligibility">
            Check student eligibility
          </Link>{" "}
          to request a review or see your result.
        </p>
      )}
      <ResourceState {...resource} />
      {items && !resource.loading && !resource.error && (
        <span hidden data-history-ready={query.toString()} />
      )}
      <HistoryPagination
        count={items?.length}
        nextCursor={resource.data?.nextCursor}
        loading={resource.loading}
      />
      {items?.length === 0 && (
        <Empty
          title={
            query.has("cursor")
              ? "No records on this page"
              : section === "agreements"
                ? "No agreements yet"
                : section === "applications"
                  ? "No applications yet"
                  : "Nothing here yet"
          }
        >
          {query.has("cursor") ? (
            "There are no more accessible records at this position. Return to newest records or use your browser’s Back button."
          ) : section === "agreements" ? (
            "Joining a team does not create an agreement. Agreements appear here after a bounty invitation is accepted."
          ) : section === "applications" ? (
            <>
              Applications appear here when you apply or join a proposal. Signed
              work is in{" "}
              <Link href="/?view=workspace&tab=agreements">Agreements</Link>; an
              empty application list does not mean there is no work to do.
            </>
          ) : (
            "Start by exploring bounties, posting a listing or joining a team."
          )}
        </Empty>
      )}
      {items?.map((item) => {
        if ("proposal" in item)
          return (
            <section
              key={item.id}
              id={`application-${item.id}`}
              tabIndex={-1}
              data-history-item={item.id}
            >
              <h2>
                {account.campus_verified ? (
                  <Link href={detail("bounties", item.task_id)}>
                    {item.task_title || "View bounty"}
                  </Link>
                ) : (
                  "Application history"
                )}
              </h2>
              <ApplicationCard
                application={item}
                account={account}
                reload={resource.reload}
                discussionUrl={detail("workspace", item.id, "application")}
                openAgreement={(id) =>
                  router.push(detail("workspace", id, "agreement"))
                }
              />
            </section>
          );
        if ("captain_id" in item)
          return (
            <article
              key={item.id}
              data-history-item={item.id}
              tabIndex={-1}
              className="cb-panel cb-row cb-agreement-card"
            >
              <div>
                <h2>
                  <Link href={detail("workspace", item.id, "agreement")}>
                    {(item.effectiveTerms?.terms ?? item.terms).taskTitle}
                  </Link>
                </h2>
                <p>
                  {item.owner_id === account.id
                    ? "You are the publisher"
                    : "You are a participant"}{" "}
                  · {money(item.currentRewardCents ?? item.terms.rewardCents)}
                </p>
              </div>
              <Status value={item.state} />
              <AgreementSummary
                agreement={item}
                publisher={item.owner_id === account.id}
              />
            </article>
          );
        if ("buyer_id" in item)
          return (
            <article
              key={item.id}
              className="cb-panel cb-row"
              data-history-item={item.id}
              tabIndex={-1}
            >
              <div>
                <h2>
                  <Link href={detail("workspace", item.id, "order")}>
                    {item.terms.title}
                  </Link>
                </h2>
                <p>
                  {item.buyer_id === account.id ? "Buying" : "Selling"} ·{" "}
                  {money(item.total_cents)}
                </p>
              </div>
              <Status value={item.state} />
            </article>
          );
        return (
          <article
            key={item.id}
            className="cb-panel cb-row"
            data-history-item={item.id}
            tabIndex={-1}
          >
            <h2>
              <Link
                href={detail(
                  "reward_cents" in item ? "bounties" : "market",
                  item.id,
                )}
              >
                {item.title}
              </Link>
            </h2>
            <strong>
              {money(
                "reward_cents" in item ? item.reward_cents : item.price_cents,
              )}
            </strong>
            <p>
              {item.visibility} · version {item.terms_version}
            </p>
            <Link
              className="cb-button"
              href={`${detail("reward_cents" in item ? "bounties" : "market", item.id)}&edit=1`}
            >
              {"reward_cents" in item ? "Edit bounty" : "Edit listing"}
            </Link>
          </article>
        );
      })}
    </>
  );
}
