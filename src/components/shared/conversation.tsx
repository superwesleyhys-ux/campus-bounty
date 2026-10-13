"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import type { Account } from "./types";
import { Feedback, Field } from "./ui";
import {
  conversationRole,
  type ConversationScope,
  type ApplicationConversationContext,
} from "./conversation-types";
import { useConversationState } from "./conversation-state";
import { ConversationDiscovery } from "./conversation-discovery";
import { useConversationDraft } from "./conversation-draft";

type Props = {
  scope: ConversationScope;
  id: string;
  account: Account;
  onApplicationContext?: (
    context: ApplicationConversationContext | null,
    campusVerified: boolean,
  ) => void;
  onRefresh?: () => void;
};
export function Conversation(props: Props) {
  return (
    <ScopedConversation
      key={`${props.account.id}:${props.scope}:${props.id}`}
      {...props}
    />
  );
}
function ScopedConversation({
  scope,
  id,
  account,
  onApplicationContext,
  onRefresh,
}: Props) {
  const history = useConversationState(account.id, scope, id);
  const draft = useConversationDraft(account.id, scope, id);
  const list = useRef<HTMLOListElement>(null);
  const olderButton = useRef<HTMLButtonElement>(null);
  const position = useRef<{ height: number; top: number } | null>(null);
  const first = useRef(true);
  const confirmedMessage = useRef<string | null>(null);
  const data = history.data;
  const application = data?.applicationContext;
  const sendUnavailableReason =
    history.accountSendUnavailableReason ?? application?.sendUnavailableReason;
  useEffect(() => {
    onApplicationContext?.(application ?? null, history.campusVerified);
  }, [application, history.campusVerified, onApplicationContext]);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node || !data) return;
    // This intent survives application busy/error hiding. Consume it only
    // after authorized history is rendered; scrolling never changes focus.
    if (confirmedMessage.current) {
      const target = Array.from(node.children).find(
        (item) =>
          (item as HTMLElement).dataset.messageId === confirmedMessage.current,
      );
      if (target) {
        node.scrollTop +=
          target.getBoundingClientRect().top -
          node.getBoundingClientRect().top -
          node.clientTop;
      } else {
        // A recovered receipt may predate the loaded window. Keep the latest
        // authorized history visible without fabricating an unloaded message.
        node.scrollTop = node.scrollHeight;
      }
      confirmedMessage.current = null;
      first.current = false;
    } else if (position.current) {
      node.scrollTop =
        position.current.top + node.scrollHeight - position.current.height;
      position.current = null;
      (data.nextCursor ? olderButton.current : node)?.focus({
        preventScroll: true,
      });
    } else if (first.current) {
      node.scrollTop = node.scrollHeight;
      first.current = false;
    }
  }, [data]);
  const canRecover =
    !!data &&
    !history.denied &&
    history.writable &&
    (scope === "applicationId" ||
      (account.campus_verified && account.account_status === "active"));
  const canSend =
    canRecover && (scope !== "applicationId" || application?.canSend === true);
  const sendAllowed = draft.phase === "unknown" ? canRecover : canSend;
  async function older() {
    const node = list.current;
    if (node)
      position.current = { height: node.scrollHeight, top: node.scrollTop };
    if (!(await history.read("older"))) position.current = null;
  }
  return (
    <section className="cb-panel cb-conversation" aria-label="Conversation">
      <div className="cb-row">
        <h2>
          {scope === "applicationId"
            ? "Application discussion"
            : "Conversation"}
        </h2>
        <button
          className="cb-button"
          data-refresh-messages
          onClick={() => (onRefresh ? onRefresh() : void history.read())}
          disabled={!!history.busy}
        >
          Refresh messages
        </button>
      </div>
      <p className="cb-fine">
        {scope === "agreementId"
          ? "Private to the publisher and signed collaborators, including people who later leave the team. Later team joiners are not included."
          : scope === "applicationId"
            ? "Private to the publisher, applicant and proposed participants listed in this application, including people who have not consented or later leave the team. Later team joiners and other applicants are not included. Chatting does not record consent or change bounty terms."
            : "Private to this order’s buyer and seller."}{" "}
        Refresh to check for new messages.
      </p>
      <Feedback error={history.error} />
      {history.denied && (
        <p role="alert">
          Conversation unavailable. Your access may have changed. Private
          messages, participants and drafts are hidden. Refresh messages to
          check your access again, or sign in again if your account changed.
        </p>
      )}
      <p className="cb-fine" role="status">
        {history.busy
          ? history.busy === "people"
            ? "Loading participants…"
            : "Loading messages…"
          : history.notice}
      </p>
      {data && (
        <>
          {application &&
            (!application.canSend ||
              !!history.accountSendUnavailableReason) && (
              <div className="cb-alert" role="status">
                <h3>Application discussion is read-only</h3>
                <p>
                  {sendUnavailableReason === "account_restricted"
                    ? "Sending requires an active account. Your private history remains available."
                    : sendUnavailableReason === "membership_required"
                      ? "Renew your campus email verification to send while this application and bounty remain open."
                      : application.applicationState === "accepted"
                        ? "This application was accepted. Its discussion stays here as a read-only record. New collaboration messages belong in the agreement."
                        : `This ${sendUnavailableReason === "task_closed" ? "bounty" : "application"} is ${sendUnavailableReason === "task_closed" ? application.taskStatus : application.applicationState}. New messages cannot be sent here.`}
                </p>
                <p className="cb-fine">
                  Any saved draft stays with this application. An unconfirmed
                  earlier request can still be recovered when your current
                  account and campus access permit it.
                </p>
                {application.agreementId && (
                  <Link
                    className="cb-button"
                    href={`/?view=workspace&tab=agreements&resource=agreement&id=${application.agreementId}`}
                  >
                    Open accepted agreement
                  </Link>
                )}
                {sendUnavailableReason === "membership_required" && (
                  <Link href="/?view=account">Review campus verification</Link>
                )}
              </div>
            )}
          <ConversationDiscovery
            accountId={account.id}
            scope={scope}
            id={id}
            invalidate={history.invalidate}
            beginAuthority={
              scope === "applicationId"
                ? history.beginDiscoveryAuthority
                : undefined
            }
            revision={history.revision}
            returnToHistory={() => {
              list.current?.focus({ preventScroll: true });
              list.current?.scrollIntoView({
                block: "nearest",
                behavior: "instant",
              });
            }}
          />
          <details className="cb-conversation-people" open>
            <summary>Participants ({data.participantCount})</summary>
            <p className="cb-fine">
              Current display names are editable; they are not verified legal
              names.
            </p>
            <ul aria-label="Conversation participants" tabIndex={0}>
              {data.participants.map((p) => (
                <li key={p.id}>
                  <strong>
                    {p.displayName}
                    {p.id === account.id ? " · You" : ""}
                  </strong>
                  <span>{conversationRole(p.role)}</span>
                </li>
              ))}
            </ul>
            <p className="cb-fine">
              {data.participants.length} of {data.participantCount} participants
              shown.
            </p>
            {data.nextParticipantCursor && (
              <button
                className="cb-button"
                disabled={!!history.busy}
                onClick={() => void history.read("people")}
              >
                Load more participants
              </button>
            )}
          </details>
          <button
            ref={olderButton}
            className="cb-button"
            disabled={!!history.busy || !data.nextCursor}
            onClick={() => void older()}
          >
            Load older messages
          </button>
          {!data.nextCursor && (
            <p className="cb-fine">
              Beginning of conversation · No older messages.
            </p>
          )}
          <ol
            ref={list}
            className="cb-messages"
            aria-label="Message history"
            tabIndex={0}
          >
            {data.items.map((m) => (
              <li key={m.id} data-message-id={m.id}>
                <div className="cb-row">
                  <strong>
                    {m.author ? (
                      <>
                        {m.author.displayName}
                        {m.author.id === account.id ? " · You" : ""}
                        <span className="cb-message-role">
                          {conversationRole(m.author.role)}
                        </span>
                      </>
                    ) : (
                      "Author unavailable"
                    )}
                  </strong>
                  <time dateTime={m.createdAt}>
                    {new Date(m.createdAt).toLocaleString("en-US")}
                  </time>
                </div>
                <p className="cb-prewrap">{m.body}</p>
              </li>
            ))}
          </ol>
          {data.items.length === 0 && (
            <p>Start the conversation with a question or update.</p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (sendAllowed) {
                const messageId = await draft.send();
                if (messageId && scope === "applicationId")
                  confirmedMessage.current = messageId;
                void history.read();
              }
            }}
          >
            <Field label="Message">
              <textarea
                required
                maxLength={4000}
                rows={3}
                value={draft.body}
                disabled={draft.phase !== "idle"}
                onChange={(e) => draft.edit(e.target.value)}
              />
            </Field>
            {draft.phase === "idle" &&
              !draft.storageFailed &&
              draft.body.trim() && (
                <p className="cb-fine" role="status">
                  Draft saved in this browser tab for this account. It will be
                  here when you return or reload this tab. Not sent.
                </p>
              )}
            {draft.storageFailed && (
              <p className="cb-alert" role="alert">
                Browser storage is unavailable. Your draft and exact request are
                kept in this open page’s memory, including route returns.
                Recovery after a reload or closing this tab is not guaranteed.
                Keep this tab open until the outcome is confirmed.
              </p>
            )}
            <Feedback error={draft.error} notice={draft.notice} />
            {draft.phase === "unknown" && (
              <div className="cb-alert" role="alert">
                <h3>Message outcome not confirmed</h3>
                <p>
                  Your exact message and request key are preserved. Editing is
                  paused. Recover the same request to confirm whether it was
                  sent; refreshing history alone does not confirm it.
                </p>
                <button
                  type="submit"
                  className="cb-button"
                  disabled={!canRecover || !!history.busy}
                >
                  Recover same message
                </button>
              </div>
            )}
            {draft.phase !== "unknown" && (
              <button
                type="submit"
                className="cb-button cb-primary"
                disabled={
                  !canSend ||
                  !!history.busy ||
                  draft.phase !== "idle" ||
                  !draft.body.trim()
                }
              >
                {draft.phase === "sending"
                  ? "Confirming message…"
                  : "Send message"}
              </button>
            )}
            {!canRecover && (
              <p className="cb-fine">
                Sending requires an active account and current campus email
                verification.
              </p>
            )}
          </form>
        </>
      )}
    </section>
  );
}
