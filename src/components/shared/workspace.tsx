"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "./api";
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
  type PageResult,
} from "./types";
import { Empty, ResourceState, Status } from "./ui";
export { AgreementDetail } from "./agreement-detail";
export { OrderDetail } from "./order-detail";

export function Workspace({ account }: { account: Account }) {
  const query = useSearchParams(),
    router = useRouter(),
    section = query.get("tab") || "applications";
  const path =
    {
      applications: "applications",
      agreements: "agreements",
      orders: "orders",
      posted: "tasks?scope=mine&limit=100",
      selling: "products?scope=mine&limit=100",
    }[section] || "applications";
  const resource = useResource<
    Application[] | Agreement[] | Order[] | PageResult<Task | Product>
  >(path);
  const items = Array.isArray(resource.data)
    ? resource.data
    : resource.data?.items;
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
          Refresh activity
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
      {items?.length === 0 && (
        <Empty
          title={
            section === "agreements"
              ? "No agreements yet"
              : section === "applications"
                ? "No applications yet"
                : "Nothing here yet"
          }
        >
          {section === "agreements" ? (
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
      {items && items.length > 0 && (
        <p className="cb-fine">Showing up to 100 recent records.</p>
      )}
      {items?.map((item) => {
        if ("proposal" in item)
          return (
            <section key={item.id} id={`application-${item.id}`} tabIndex={-1}>
              <h2>
                {account.campus_verified ? (
                  <Link href={`/?view=bounties&id=${item.task_id}`}>
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
                openAgreement={(id) =>
                  router.push(
                    `/?view=workspace&id=${id}&resource=agreement&tab=agreements`,
                  )
                }
              />
            </section>
          );
        if ("captain_id" in item)
          return (
            <article
              key={item.id}
              className="cb-panel cb-row cb-agreement-card"
            >
              <div>
                <h2>
                  <Link
                    href={`/?view=workspace&id=${item.id}&resource=agreement&tab=agreements`}
                  >
                    {item.terms.taskTitle}
                  </Link>
                </h2>
                <p>
                  {item.owner_id === account.id
                    ? "You are the publisher"
                    : "You are a participant"}{" "}
                  · {money(item.terms.rewardCents)}
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
            <article key={item.id} className="cb-panel cb-row">
              <div>
                <h2>
                  <Link
                    href={`/?view=workspace&id=${item.id}&resource=order&tab=orders`}
                  >
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
          <article key={item.id} className="cb-panel cb-row">
            <h2>
              <Link
                href={`/?view=${"reward_cents" in item ? "bounties" : "market"}&id=${item.id}`}
              >
                {item.title}
              </Link>
            </h2>
            <strong>
              {money(
                "reward_cents" in item ? item.reward_cents : item.price_cents,
              )}
            </strong>
          </article>
        );
      })}
    </>
  );
}
