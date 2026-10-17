"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useResource } from "./api";
import { Empty, Feedback, ResourceState } from "./ui";
import { conversationRole } from "./conversation-types";
import { useNotificationRead } from "./notification-read";
import { notificationHref, type NotificationPage } from "./notification-types";

export function NotificationNav({ active }: { active: boolean }) {
  const resource = useResource<NotificationPage>("notifications?limit=1");
  useEffect(() => {
    const refresh = () => resource.reload();
    window.addEventListener("campus:notifications-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("campus:notifications-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [resource.reload]);
  return (
    <Link
      href="/?view=notifications"
      aria-current={active ? "page" : undefined}
    >
      Notifications
      {!resource.loading && resource.data
        ? ` (${resource.data.unreadCount} unread)`
        : resource.error
          ? " (count unavailable)"
          : " (…)"}
    </Link>
  );
}

export function Notifications({ accountId }: { accountId: string }) {
  const [unread, setUnread] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const resource = useResource<NotificationPage>(
    `notifications?limit=20&unread=${unread}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  const read = useNotificationRead(accountId, resource.reload);
  function refresh() {
    setCursors([null]);
    resource.reload();
    window.dispatchEvent(new Event("campus:notifications-changed"));
  }
  useEffect(() => {
    if (resource.data && !resource.loading)
      window.dispatchEvent(new Event("campus:notifications-changed"));
  }, [resource.data, resource.loading]);
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Your activity inbox</span>
          <h1>Notifications</h1>
          <p>
            Unread means you haven’t acknowledged an update. Check your
            agreement for work that needs action.
          </p>
          <p className="cb-fine">
            Refresh for new activity. Opening an update does not mark it as
            read.
          </p>
        </div>
        <button
          className="cb-button"
          onClick={refresh}
          disabled={resource.loading}
        >
          Refresh notifications
        </button>
      </div>
      <div className="cb-notification-tools">
        <div
          role="group"
          aria-label="Notification filter"
          className="cb-team-actions"
        >
          {[false, true].map((value) => (
            <button
              key={String(value)}
              className="cb-button"
              aria-pressed={unread === value}
              onClick={() => {
                setUnread(value);
                setCursors([null]);
              }}
              disabled={resource.loading}
            >
              {value ? "Unread" : "All updates"}
            </button>
          ))}
        </div>
        <p aria-live="polite">
          {resource.loading
            ? "Checking updates…"
            : resource.data
              ? `${resource.data.unreadCount} unread · Page ${cursors.length}`
              : "Unread count unavailable"}
        </p>
      </div>
      <Feedback error={read.error} notice={read.notice} />
      {Object.keys(read.pending).length > 0 && (
        <section className="cb-alert" aria-label="Unconfirmed read requests">
          <h2>Confirm read status</h2>
          <p>
            A read request is not yet confirmed. Retry the original request,
            even if the update is no longer in this view.
          </p>
          {Object.keys(read.pending).map((id, index) => (
            <button
              key={id}
              className="cb-button"
              disabled={!!read.busy}
              onClick={() => void read.markRead(id)}
            >
              {read.busy === id
                ? "Confirming…"
                : `Retry read request${Object.keys(read.pending).length > 1 ? ` ${index + 1}` : ""}`}
            </button>
          ))}
        </section>
      )}
      <ResourceState {...resource} />
      {!resource.loading && resource.data?.items.length === 0 && (
        <Empty
          title={
            unread
              ? "No unread updates on this page"
              : "No updates on this page"
          }
        >
          {cursors.length > 1
            ? "Return to the previous page or refresh for the newest activity."
            : "New activity from your collaborations will appear here. Your workspace still shows any work that needs action."}
        </Empty>
      )}
      <ul
        className="cb-notification-list"
        aria-label="Activity updates"
        aria-busy={resource.loading}
      >
        {resource.data?.items.map((item) => {
          const href = notificationHref(item);
          return (
            <li
              key={item.id}
              className="cb-panel cb-notification-item"
              data-notification-id={item.id}
            >
              <div className="cb-row">
                <h2>{item.title}</h2>
                <span className="cb-badge">
                  {item.readAt ? "Read" : "Unread"}
                </span>
              </div>
              {item.targetAvailable && item.target && item.contextLabel && (
                <p className="cb-notification-context">{item.contextLabel}</p>
              )}
              {item.targetAvailable && item.target && item.workContext && (
                <p className="cb-notification-work">
                  {item.workContext.milestonePosition}.{" "}
                  {item.workContext.milestoneTitle}
                  {" · Version "}
                  {item.workContext.submissionVersion}
                </p>
              )}
              <p>{item.description}</p>
              {item.listingContext && (
                <p>
                  Listing version {item.listingContext.termsVersion} · revision{" "}
                  {item.listingContext.revision}
                </p>
              )}
              {item.targetAvailable && item.target && item.messageContext && (
                <div className="cb-notification-message">
                  <strong>
                    {item.messageContext.author?.displayName ??
                      "Author unavailable"}
                  </strong>
                  {item.messageContext.author && (
                    <span className="cb-message-role">
                      {conversationRole(item.messageContext.author.role)}
                    </span>
                  )}
                  <p className="cb-prewrap">{item.messageContext.preview}</p>
                  {item.messageContext.truncated && (
                    <p className="cb-fine">
                      Preview shortened. Open update to read the full message.
                    </p>
                  )}
                  <time
                    className="cb-fine"
                    dateTime={item.messageContext.createdAt}
                  >
                    Message:{" "}
                    {new Date(item.messageContext.createdAt).toLocaleString(
                      "en-US",
                    )}
                  </time>
                </div>
              )}
              <time className="cb-fine" dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString("en-US")}
              </time>
              <div className="cb-team-actions">
                {href ? (
                  <Link className="cb-button" href={href}>
                    Open update
                  </Link>
                ) : (
                  <span className="cb-muted">
                    Target unavailable · Your access may have changed.
                  </span>
                )}
                {!item.readAt && (
                  <button
                    className="cb-button"
                    disabled={
                      !!read.busy || !!read.pending[item.id] || resource.loading
                    }
                    onClick={() => void read.markRead(item.id)}
                  >
                    Mark read
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <nav className="cb-team-actions" aria-label="Notification pages">
        <button
          className="cb-button"
          disabled={resource.loading || cursors.length === 1}
          onClick={() => setCursors((old) => old.slice(0, -1))}
        >
          Previous page
        </button>
        <button
          className="cb-button"
          disabled={resource.loading || !resource.data?.nextCursor}
          onClick={() => {
            if (resource.data?.nextCursor)
              setCursors((old) => [...old, resource.data!.nextCursor]);
          }}
        >
          Next page
        </button>
      </nav>
    </>
  );
}
