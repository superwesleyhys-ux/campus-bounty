"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { Account } from "./types";
import type {
  BeginDiscoveryAuthority,
  DiscoveryAuthorityObservation,
} from "./conversation-state";
import type {
  ConversationPage,
  ConversationScope,
  ConversationSearchPage,
  MessageContextWindow,
} from "./conversation-types";

type Result<T> = { data: T | null; busy: boolean; error: Error | null };
const empty = <T>(): Result<T> => ({ data: null, busy: false, error: null });
export function useConversationDiscovery(
  accountId: string,
  scope: ConversationScope,
  id: string,
  invalidate: () => void,
  beginAuthority?: BeginDiscoveryAuthority,
) {
  const [search, setSearch] = useState<Result<ConversationSearchPage>>(empty);
  const [context, setContext] = useState<Result<MessageContextWindow>>(empty);
  const searchVersion = useRef(0),
    contextVersion = useRef(0),
    lifetime = useRef(0);
  const searching = useRef(false);
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
      searchVersion.current++;
      contextVersion.current++;
    };
  }, []);
  const clearSearch = useCallback(() => {
    searchVersion.current++;
    searching.current = false;
    setSearch(empty());
  }, []);
  const clearContext = useCallback(() => {
    contextVersion.current++;
    setContext(empty());
  }, []);
  const rejectAccess = useCallback(() => {
    // Invalidate every panel and history synchronously before any other read resolves.
    lifetime.current++;
    clearSearch();
    clearContext();
    invalidate();
  }, [clearSearch, clearContext, invalidate]);
  const query = `${scope}=${encodeURIComponent(id)}`;
  const verifyAccount = useCallback(async () => {
    const me = await request<Account>("me");
    if (me.id !== accountId || me.account_status === "locked")
      throw new ApiError("Your account or access changed. Sign in again.", 403);
    return me;
  }, [accountId]);
  const accessFailure = useCallback(
    async (
      cause: unknown,
      selected: boolean,
      run: number,
      isCurrent: () => boolean,
      observe?: (observation: DiscoveryAuthorityObservation) => void,
    ) => {
      if (
        !(cause instanceof ApiError) ||
        ![401, 403, 404].includes(cause.status)
      )
        return false;
      if (cause.status === 404 && selected) {
        // Missing message does not prove the conversation is denied. Recheck its
        // real authorization; an outage is not evidence of permission loss either.
        try {
          const page = await request<ConversationPage>(
            `conversations?${query}`,
          );
          if (isCurrent()) observe?.({ page });
          return false;
        } catch (scopeError) {
          if (
            !(scopeError instanceof ApiError) ||
            ![401, 403, 404].includes(scopeError.status)
          )
            return false;
        }
      }
      if (run === lifetime.current) rejectAccess();
      return true;
    },
    [query, rejectAccess],
  );
  const find = useCallback(
    async (q: string, previous?: ConversationSearchPage) => {
      if (previous && searching.current) return;
      const token = ++searchVersion.current,
        run = lifetime.current;
      const observe = beginAuthority?.();
      const isCurrent = () =>
        run === lifetime.current && token === searchVersion.current;
      searching.current = true;
      setSearch({ data: previous ?? null, busy: true, error: null });
      try {
        const me = await verifyAccount();
        if (!isCurrent()) return;
        observe?.({ account: me });
        const params = new URLSearchParams({ [scope]: id, q, limit: "20" });
        if (previous?.nextCursor) params.set("cursor", previous.nextCursor);
        const page = await request<ConversationSearchPage>(
          `conversations/search?${params}`,
        );
        if (run !== lifetime.current || token !== searchVersion.current) return;
        const items = previous
          ? [
              ...new Map(
                [...previous.items, ...page.items].map((m) => [m.id, m]),
              ).values(),
            ]
          : page.items;
        setSearch({ data: { ...page, items }, busy: false, error: null });
      } catch (cause) {
        if (run !== lifetime.current) return;
        if (await accessFailure(cause, false, run, isCurrent, observe)) return;
        if (run === lifetime.current && token === searchVersion.current)
          setSearch({
            data: previous ?? null,
            busy: false,
            error:
              cause instanceof Error
                ? cause
                : new Error("Search could not be loaded. Try again."),
          });
      } finally {
        if (run === lifetime.current && token === searchVersion.current)
          searching.current = false;
      }
    },
    [accessFailure, verifyAccount, id, scope, beginAuthority],
  );
  const select = useCallback(
    async (messageId: string) => {
      const token = ++contextVersion.current,
        run = lifetime.current;
      const observe = beginAuthority?.();
      const isCurrent = () =>
        run === lifetime.current && token === contextVersion.current;
      setContext({ data: null, busy: true, error: null });
      try {
        const me = await verifyAccount();
        if (!isCurrent()) return;
        observe?.({ account: me });
        const page = await request<MessageContextWindow>(
          `conversations/message?${new URLSearchParams({ [scope]: id, messageId })}`,
        );
        if (run === lifetime.current && token === contextVersion.current)
          setContext({ data: page, busy: false, error: null });
      } catch (cause) {
        if (run !== lifetime.current) return;
        if (await accessFailure(cause, true, run, isCurrent, observe)) return;
        if (run === lifetime.current && token === contextVersion.current)
          setContext({
            data: null,
            busy: false,
            error:
              cause instanceof ApiError && [404, 422].includes(cause.status)
                ? new Error(
                    "This message is unavailable in this conversation. Return to the conversation or search for another message.",
                  )
                : cause instanceof Error
                  ? cause
                  : new Error("Message could not be loaded. Try again."),
          });
      }
    },
    [accessFailure, verifyAccount, id, scope, beginAuthority],
  );
  return { search, context, find, select, clearSearch, clearContext };
}
