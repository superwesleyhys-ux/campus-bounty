"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { Account } from "./types";
import { reconcileConversationRoster } from "./conversation-roster";
import {
  mergeMessages,
  type ConversationPage,
  type ConversationParticipantsPage,
  type ConversationScope,
} from "./conversation-types";

export type DiscoveryAuthorityObservation = {
  account?: Account;
  page?: ConversationPage;
};
export type BeginDiscoveryAuthority = () => (
  observation: DiscoveryAuthorityObservation,
) => void;

type History = Omit<ConversationPage, "scope" | "limit" | "participantLimit">;
export function useConversationState(
  accountId: string,
  scope: ConversationScope,
  id: string,
) {
  const [data, setData] = useState<History | null>(null);
  const current = useRef<History | null>(null);
  const [busy, setBusy] = useState<"recent" | "older" | "people" | null>(
    "recent",
  );
  const [backgroundError, setBackgroundError] = useState<Error | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [denied, setDenied] = useState(false);
  const [writable, setWritable] = useState(false);
  const [campusVerified, setCampusVerified] = useState(false);
  const [accountSendUnavailableReason, setAccountSendUnavailableReason] =
    useState<"account_restricted" | "membership_required" | null>(null);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0),
    running = useRef(false);
  const authorityVersion = useRef(0);
  const observeAccount = useCallback(
    (me: Account) => {
      setCampusVerified(me.id === accountId && me.campus_verified);
      setWritable(
        me.id === accountId &&
          me.account_status === "active" &&
          me.campus_verified,
      );
      setAccountSendUnavailableReason(
        me.account_status !== "active"
          ? "account_restricted"
          : !me.campus_verified
            ? "membership_required"
            : null,
      );
    },
    [accountId],
  );
  // A lease belongs to this mounted account/application and one discovery read.
  // New reads and history revalidation supersede older observations; neither
  // private history nor the independent pending-send state is discarded.
  const beginDiscoveryAuthority = useCallback<BeginDiscoveryAuthority>(() => {
    const token = generation.current;
    const version = ++authorityVersion.current;
    return ({ account: me, page }) => {
      if (
        scope !== "applicationId" ||
        running.current ||
        token !== generation.current ||
        version !== authorityVersion.current
      )
        return;
      if (me && me.id === accountId && me.account_status !== "locked")
        observeAccount(me);
      if (
        page?.scope.type === "application" &&
        page.scope.id === id &&
        page.applicationContext?.applicationId === id &&
        current.current
      ) {
        const next = {
          ...current.current,
          applicationContext: page.applicationContext,
        };
        current.current = next;
        setData(next);
      }
    };
  }, [accountId, id, scope, observeAccount]);
  const read = useCallback(
    async (mode: "recent" | "older" | "people" = "recent", silent = false) => {
      if (running.current) return;
      const previous = current.current;
      if (mode === "older" && !previous?.nextCursor) return;
      if (mode === "people" && !previous?.nextParticipantCursor) return;
      running.current = true;
      authorityVersion.current++;
      const token = generation.current;
      if (!silent) {
        setBusy(mode);
        if (scope === "applicationId") setWritable(false);
        setRevision((n) => n + 1);
        setError(null);
        setNotice("");
      }
      try {
        const me = await request<Account>("me");
        if (token !== generation.current) return;
        observeAccount(me);
        if (me.id !== accountId || me.account_status === "locked")
          throw new ApiError(
            "Your account or access changed. Sign in again to view this conversation.",
            403,
          );
        const query = `${scope}=${encodeURIComponent(id)}`;
        let next: History;
        if (mode === "people") {
          // Validate/use the independent continuation cursor, then reconcile
          // from a fresh first page so removals before that cursor cannot persist.
          await request<ConversationParticipantsPage>(
            `conversations/participants?${query}&cursor=${encodeURIComponent(previous!.nextParticipantCursor!)}`,
          );
          const first = await request<ConversationParticipantsPage>(
            `conversations/participants?${query}`,
          );
          const roster = await reconcileConversationRoster(
            query,
            first,
            previous!.participants.length + first.limit,
            () => token === generation.current,
          );
          if (!roster) return;
          const contextPage =
            scope === "applicationId"
              ? await request<ConversationPage>(
                  `conversations?${query}&limit=1`,
                )
              : null;
          next = {
            ...previous!,
            ...(contextPage
              ? { applicationContext: contextPage.applicationContext }
              : {}),
            participants: roster.participants,
            participantCount: roster.participantCount,
            nextParticipantCursor: roster.nextParticipantCursor,
            items: previous!.items.map((m) => ({
              ...m,
              author: m.author
                ? (roster.authority.get(m.author.id) ?? null)
                : null,
            })),
          };
        } else {
          const page = await request<ConversationPage>(
            `conversations?${query}${mode === "older" ? `&cursor=${encodeURIComponent(previous!.nextCursor!)}` : ""}`,
          );
          let incoming = page.items;
          let applicationContext = page.applicationContext;
          // Refresh bridges every new page back to the already loaded history, so
          // even >30 arrivals cannot create an invisible gap between old and new.
          if (mode === "recent" && previous?.items.length) {
            const known = new Set(previous.items.map((m) => m.id));
            let edge = page.nextCursor,
              pages = 1;
            while (edge && !incoming.some((m) => known.has(m.id))) {
              if (silent && pages++ >= 3)
                throw new Error(
                  "Many new messages arrived. Use Refresh messages to load the complete gap.",
                );
              const more = await request<ConversationPage>(
                `conversations?${query}&cursor=${encodeURIComponent(edge)}`,
              );
              incoming = [...incoming, ...more.items];
              applicationContext = more.applicationContext;
              edge = more.nextCursor;
              if (token !== generation.current) return;
            }
          }
          const roster = await reconcileConversationRoster(
            query,
            {
              items: page.participants,
              participantCount: page.participantCount,
              nextCursor: page.nextParticipantCursor,
            },
            Math.max(
              page.participants.length,
              previous?.participants.length ?? 0,
            ),
            () => token === generation.current,
          );
          if (!roster) return;
          next = {
            ...(scope === "applicationId" ? { applicationContext } : {}),
            items: mergeMessages(previous?.items ?? [], incoming).map((m) => ({
              ...m,
              author: m.author
                ? (roster.authority.get(m.author.id) ?? null)
                : null,
            })),
            participants: roster.participants,
            participantCount: roster.participantCount,
            nextParticipantCursor: roster.nextParticipantCursor,
            nextCursor:
              mode === "older" || !previous?.items.length
                ? page.nextCursor
                : previous.nextCursor,
          };
        }
        if (token !== generation.current) return;
        current.current = next;
        setData(next);
        setDenied(false);
        setBackgroundError(null);
        setError(null);
        if (!silent)
          setNotice(
            mode === "people"
              ? "More participants loaded."
              : mode === "older"
                ? "Older messages loaded. Your reading position is preserved."
                : "Latest messages checked. Automatic updates continue while this tab is visible.",
          );
        return true;
      } catch (cause) {
        if (token !== generation.current) return;
        if (
          cause instanceof ApiError &&
          [401, 403, 404].includes(cause.status)
        ) {
          generation.current++;
          running.current = false;
          current.current = null;
          setData(null);
          setDenied(true);
          setWritable(false);
          setBusy(null);
          setRevision((n) => n + 1);
        }
        setWritable(false);
        (silent ? setBackgroundError : setError)(
          cause instanceof Error
            ? cause
            : new Error("Conversation could not be loaded."),
        );
        return false;
      } finally {
        if (token === generation.current) {
          running.current = false;
          setBusy(null);
        }
      }
    },
    [accountId, scope, id, observeAccount],
  );
  const invalidate = useCallback(() => {
    generation.current++;
    running.current = false;
    current.current = null;
    setData(null);
    setDenied(true);
    setWritable(false);
    setBusy(null);
    setNotice("");
  }, []);
  useEffect(() => {
    void read();
    const storage = (event: StorageEvent) => {
      if (
        ["campus:auth-version", "campus:account-version"].includes(
          event.key ?? "",
        )
      )
        invalidate();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("campus:session-expired", invalidate);
    return () => {
      // Cleanup cancels stale reads; it is not evidence of permission loss.
      // React may run setup/cleanup/setup on the initial development mount.
      generation.current++;
      running.current = false;
      window.removeEventListener("storage", storage);
      window.removeEventListener("campus:session-expired", invalidate);
    };
  }, [read, invalidate]);
  return {
    data: scope === "applicationId" && (busy || error) ? null : data,
    busy,
    error: error ?? backgroundError,
    denied,
    writable,
    campusVerified,
    accountSendUnavailableReason,
    beginDiscoveryAuthority,
    notice,
    revision,
    read,
    invalidate,
  };
}
