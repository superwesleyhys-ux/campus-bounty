"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Conversation } from "./conversation";
import type { ApplicationConversationContext } from "./conversation-types";
import { useResource } from "./api";
import type { Account, Application } from "./types";
import { ResourceState, Status } from "./ui";

type ApplicationHistory = Pick<
  Application,
  "id" | "state" | "proposal" | "members"
> & {
  created_at: string;
  task: { id: string; title: string } | null;
};

// A notification's exact private target must not depend on the recent-100 list.
export function ApplicationDetail({
  id,
  account,
}: {
  id: string;
  account: Account;
}) {
  const discussion = useRef<HTMLDivElement>(null);
  const restoreRefreshFocus = useRef(false);
  const [context, setContext] = useState<ApplicationConversationContext | null>(
    null,
  );
  const [campusVerified, setCampusVerified] = useState(false);
  const receiveContext = useCallback(
    (next: ApplicationConversationContext | null, verified: boolean) => {
      setContext(next);
      setCampusVerified(verified);
      if (next && restoreRefreshFocus.current) {
        restoreRefreshFocus.current = false;
        discussion.current
          ?.querySelector<HTMLButtonElement>("[data-refresh-messages]")
          ?.focus({ preventScroll: true });
      }
    },
    [],
  );
  const resource = useResource<ApplicationHistory>(`applications/${id}`);
  // Do not retain private content while rechecking current access.
  const application =
    !resource.loading && !resource.error ? resource.data : undefined;
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Private application history</span>
          <h1>Application details</h1>
        </div>
        <button
          className="cb-button"
          onClick={resource.reload}
          disabled={resource.loading}
        >
          Refresh application
        </button>
      </div>
      <ResourceState {...resource} />
      {application && (
        <div ref={discussion} className="cb-application-detail">
          {context && (
            <section
              id={`application-${application.id}`}
              tabIndex={-1}
              className="cb-panel"
            >
              <div className="cb-row">
                <h2>
                  {(campusVerified && application.task?.title) ||
                    "Application history"}
                </h2>
                <Status value={context.applicationState} />
              </div>
              <p className="cb-prewrap">{application.proposal}</p>
              <time className="cb-fine" dateTime={application.created_at}>
                {new Date(application.created_at).toLocaleString("en-US")}
              </time>
              <h3>Participant consent</h3>
              <ul>
                {application.members.map((member) => (
                  <li key={member.user_id}>
                    {member.user_id === account.id
                      ? "You"
                      : member.display_name || "Team member"}
                    {" — "}
                    {member.confirmed ? "Agreed" : "Waiting for consent"}
                  </li>
                ))}
              </ul>
              {campusVerified && application.task ? (
                <Link
                  className="cb-button"
                  href={`/?view=bounties&id=${application.task.id}#application-${application.id}`}
                >
                  Open bounty and available actions
                </Link>
              ) : (
                <p className="cb-fine">
                  Your private application history is available. Bounty details
                  require current campus verification.
                </p>
              )}
            </section>
          )}
          <Conversation
            scope="applicationId"
            id={application.id}
            account={account}
            onApplicationContext={receiveContext}
            onRefresh={() => {
              restoreRefreshFocus.current = true;
              resource.reload();
            }}
          />
        </div>
      )}
    </>
  );
}
