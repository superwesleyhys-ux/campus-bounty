"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { GraduationCap, Plus } from "lucide-react";
import { ApiError, useMutation, useResource } from "./api";
import { Messages } from "./messages";
import { SampleSwitcher } from "./sample-switcher";
import { SignIn } from "./auth";
import { Catalog } from "./catalog";
import { historyDetailUrl } from "./history-pagination";
import { useHistoryReturn } from "./history-return";
import { ListingEditor } from "./listing-editor";
import { Publish } from "./publish";
import { TaskDetail } from "./task-detail";
import { ProductDetail } from "./product-detail";
import { ApplicationDetail } from "./application-detail";
import { Workspace, AgreementDetail, OrderDetail } from "./workspace";
import { Teams } from "./teams";
import { Feedback, ResourceState } from "./ui";
import type { Account } from "./types";
import "./shared.css";
import { LocalAudit } from "./qa-audit";
import { AccountPage } from "./account";
import { NotificationNav, Notifications } from "./notifications";
import { EligibilityReview } from "./eligibility-review";

const navigation = [
  ["bounties", "Bounties"],
  ["market", "Marketplace"],
  ["workspace", "Workspace"],
  ["messages", "Messages"],
  ["notifications", "Notifications"],
  ["teams", "Teams"],
  ["saved", "Saved"],
  ["account", "Account"],
];
export default function SharedCampus({
  local,
  audit = false,
}: {
  local: boolean;
  audit?: boolean;
}) {
  const query = useSearchParams(),
    router = useRouter(),
    me = useResource<Account>("me"),
    preview = useResource<{ enabled: boolean }>(local ? "auth/preview" : null);
  const view = query.get("view") || "bounties",
    id = query.get("id"),
    kind = query.get("kind") === "product" ? "product" : "task";
  const [expired, setExpired] = useState(false),
    main = useRef<HTMLElement>(null),
    logout = useMutation("session");
  const rememberHistory = useHistoryReturn(
    main,
    me.loading || me.error ? undefined : me.data?.id,
    query.toString(),
  );
  useEffect(() => {
    const expire = () => {
      setExpired(true);
      me.reload();
    };
    window.addEventListener("campus:session-expired", expire);
    const synchronize = (event: StorageEvent) => {
      if (
        ["campus:auth-version", "campus:account-version"].includes(
          event.key || "",
        )
      )
        me.reload();
    };
    window.addEventListener("storage", synchronize);
    return () => {
      window.removeEventListener("campus:session-expired", expire);
      window.removeEventListener("storage", synchronize);
    };
  }, [me.reload]);
  useEffect(() => {
    document.title = `${id ? "Details" : view === "eligibility-review" ? "Student reviews" : navigation.find((n) => n[0] === view)?.[1] || "Post a listing"} · Campus Bounty`;
  }, [view, id, me.data?.id]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!/^(application|team)-[a-f0-9-]{36}$/i.test(hash)) return;
    const focusTarget = () => {
      const target = document.getElementById(hash);
      if (!target) return false;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
      return true;
    };
    if (focusTarget()) return;
    const observer = new MutationObserver(() => {
      if (focusTarget()) observer.disconnect();
    });
    if (main.current)
      observer.observe(main.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [view, id, me.data?.id]);
  const detailUrl = (section: string, resource: string) => {
    const next = new URLSearchParams(query.toString());
    next.set("view", section);
    next.set("id", resource);
    return `/?${next}`;
  };
  const back = new URLSearchParams(query.toString());
  back.delete("id");
  back.delete("resource");
  back.delete("edit");
  const returnView = query.get("returnView");
  if (["workspace", "saved", "bounties", "market"].includes(returnView || ""))
    back.set("view", returnView!);
  back.delete("returnView");
  const backView = back.get("view") || view;
  const account = me.loading || me.error ? undefined : me.data;
  return (
    <div className="cb-app">
      <a className="cb-skip" href="#shared-main">
        Skip to main content
      </a>
      <aside className="cb-preview" aria-label="Preview status">
        {preview.data?.enabled
          ? "Local sample accounts · No real university verification, external email or actual payment."
          : `${local ? "Local development" : "Preview"} · Payment availability and verified status are shown in each transaction.`}
      </aside>
      <header className="cb-header">
        <Link className="cb-brand" href="/?view=bounties">
          <GraduationCap size={30} aria-hidden="true" />
          <span>
            Campus Bounty<small>U.S. university community</small>
          </span>
        </Link>
        <div className="cb-header-actions">
          {account && (
            <>
              <Link
                className="cb-button cb-primary"
                href={`/?view=publish&kind=${view === "market" ? "product" : "task"}`}
              >
                <Plus size={16} aria-hidden="true" />
                Post a listing
              </Link>
              <button
                className="cb-button"
                disabled={logout.busy}
                onClick={async () => {
                  const result = await logout.run(
                    "auth/session",
                    {},
                    "",
                    "DELETE",
                  );
                  if (result) {
                    setExpired(false);
                    me.reload();
                  }
                }}
              >
                {logout.busy ? "Signing out…" : "Sign out"}
              </button>
            </>
          )}
        </div>
      </header>
      <nav className="cb-nav" aria-label="Main navigation">
        {navigation.map(([value, name]) =>
          value === "notifications" && account ? (
            <NotificationNav
              key={`${account.id}:${query.toString()}`}
              active={view === value}
            />
          ) : (
            <Link
              key={value}
              href={`/?view=${value}`}
              aria-current={view === value ? "page" : undefined}
            >
              {name}
            </Link>
          ),
        )}
      </nav>
      <main
        id="shared-main"
        tabIndex={-1}
        ref={main}
        className="cb-main"
        onClickCapture={rememberHistory}
      >
        <Feedback error={logout.error} />
        {me.loading && !account ? (
          <ResourceState {...me} />
        ) : me.error instanceof ApiError && me.error.status === 401 ? (
          <SignIn
            local={local}
            sample={preview.data?.enabled === true}
            expired={expired}
            onSuccess={() => {
              setExpired(false);
              me.reload();
            }}
          />
        ) : me.error ? (
          <ResourceState {...me} />
        ) : account ? (
          <>
            <div className="cb-account-line">
              <span>
                Welcome, <strong>{account.display_name}</strong>
                {preview.data?.enabled && " · Sample account"}
              </span>
              <span>
                <Link href="/?view=account#student-eligibility">
                  {account.can_apply
                    ? preview.data?.enabled
                      ? "Sample student eligibility"
                      : "Student eligibility verified"
                    : "Check student eligibility"}
                </Link>
              </span>
            </div>
            {preview.data?.enabled && (
              <SampleSwitcher account={account} onSuccess={me.reload} />
            )}
            {view === "messages" && (
              <Messages key={account.id} accountId={account.id} />
            )}
            {(!account.campus_verified ||
              account.account_status !== "active") && (
              <p className="cb-alert">
                {!account.campus_verified
                  ? "Your campus verification has expired. Sign out and verify your university email again to start new activity. Your existing agreements and orders remain available in Workspace."
                  : "Your account is restricted. You can review existing activity and update your profile, but cannot start new activity."}
              </p>
            )}
            {id && (
              <Link className="cb-back" href={`/?${back}`}>
                ← Back to{" "}
                {backView === "market"
                  ? "marketplace"
                  : backView === "workspace"
                    ? "workspace"
                    : backView === "saved"
                      ? "saved bounties"
                      : "bounties"}
              </Link>
            )}
            {(view === "bounties" || view === "saved") &&
              (id ? (
                query.get("edit") === "1" ? (
                  <ListingEditor
                    key={`${account.id}:${id}`}
                    id={id}
                    kind="task"
                    account={account}
                  />
                ) : (
                  <TaskDetail
                    key={`${account.id}:${id}`}
                    id={id}
                    account={account}
                    openAgreement={(value) =>
                      router.push(
                        historyDetailUrl(
                          query,
                          "workspace",
                          value,
                          "agreement",
                        ),
                      )
                    }
                  />
                )
              ) : (
                <Catalog
                  key={`${account.id}:${view}`}
                  kind="task"
                  saved={view === "saved"}
                  openUrl={(value) => detailUrl(view, value)}
                />
              ))}
            {view === "market" &&
              (id ? (
                query.get("edit") === "1" ? (
                  <ListingEditor
                    key={`${account.id}:${id}`}
                    id={id}
                    kind="product"
                    account={account}
                  />
                ) : (
                  <ProductDetail
                    key={`${account.id}:${id}`}
                    id={id}
                    account={account}
                    openOrder={(value) =>
                      router.push(
                        historyDetailUrl(query, "workspace", value, "order"),
                      )
                    }
                  />
                )
              ) : (
                <Catalog
                  key={`${account.id}:${view}`}
                  kind="product"
                  openUrl={(value) => detailUrl(view, value)}
                />
              ))}
            {view === "publish" && (
              <Publish
                key={`${account.id}:${kind}`}
                account={account}
                kind={kind}
                done={(value) =>
                  router.push(
                    `/?view=${kind === "task" ? "bounties" : "market"}&id=${value}`,
                  )
                }
              />
            )}
            {view === "notifications" && (
              <Notifications key={account.id} accountId={account.id} />
            )}
            {view === "teams" && <Teams key={account.id} account={account} />}
            {view === "account" && (
              <AccountPage
                key={account.id}
                account={account}
                onAccountChanged={me.reload}
              />
            )}
            {view === "eligibility-review" && (
              <EligibilityReview key={account.id} account={account} />
            )}
            {view === "workspace" &&
              (id ? (
                query.get("resource") === "application" ? (
                  <ApplicationDetail
                    key={`${account.id}:${id}`}
                    id={id}
                    account={account}
                  />
                ) : query.get("resource") === "order" ? (
                  <OrderDetail
                    key={`${account.id}:${id}`}
                    id={id}
                    account={account}
                  />
                ) : (
                  <AgreementDetail
                    key={`${account.id}:${id}`}
                    id={id}
                    account={account}
                  />
                )
              ) : (
                <Workspace key={account.id} account={account} />
              ))}
            {!navigation.some((n) => n[0] === view) &&
              !["publish", "eligibility-review"].includes(view) && (
                <p>
                  Page not found.{" "}
                  <Link href="/?view=bounties">Return to bounties</Link>
                </p>
              )}
          </>
        ) : null}
      </main>
      <footer className="cb-footer">
        Made for campus collaboration.{" "}
        <Link href="/?view=workspace">Open your workspace.</Link>
      </footer>
      {audit && <LocalAudit />}
    </div>
  );
}
