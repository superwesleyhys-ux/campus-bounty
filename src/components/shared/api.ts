"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "network_error",
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/${path}`, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal ?? AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      "Connection interrupted. Your entries are still here. Retry to check or finish this request.",
    );
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "me" && !path.startsWith("auth/"))
      window.dispatchEvent(new Event("campus:session-expired"));
    throw new ApiError(
      data.detail || "This request could not be completed.",
      response.status,
      data.code,
      data.requestId,
    );
  }
  if (
    path === "auth/sessions" ||
    (path === "auth/session" && options.method === "DELETE")
  ) {
    try {
      localStorage.setItem("campus:auth-version", crypto.randomUUID());
    } catch {
      /* optional storage */
    }
  }
  return data;
}

export function useResource<T>(path: string | null): {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error?: Error;
    loading: boolean;
  }>({ path: null, loading: true });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((old) => ({
      path,
      data: old.path === path ? old.data : undefined,
      loading: true,
    }));
    request<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted)
          setState({ path, data, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ path, error, loading: false });
      },
    );
    return () => controller.abort();
  }, [path, revision]);
  return { ...(state.path === path ? state : { loading: !!path }), reload };
}

// Store only a body digest and random key, never request bodies or credentials.
export async function mutationKey(
  scope: string,
  path: string,
  method: string,
  body: unknown,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const hash = Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const storage = `campus:pending:${scope}:${method}:${path}:${hash}`;
  let key: string | null = null;
  try {
    key = sessionStorage.getItem(storage);
  } catch {
    /* Storage may be blocked. */
  }
  key ||= crypto.randomUUID();
  try {
    sessionStorage.setItem(storage, key);
  } catch {
    /* The in-memory key still protects retries. */
  }
  return { storage, key };
}
export function useMutation(scope: string) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [notice, setNotice] = useState("");
  const running = useRef(false),
    pending = useRef(new Map<string, { storage: string; key: string }>());
  const clear = useCallback(() => {
    setError(null);
    setNotice("");
  }, []);
  async function run<T>(
    path: string,
    body: unknown,
    success: string,
    method = "POST",
  ): Promise<T | undefined> {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    const identity = JSON.stringify([scope, method, path, body]);
    let entry;
    try {
      entry =
        pending.current.get(identity) ??
        (await mutationKey(scope, path, method, body));
      pending.current.set(identity, entry);
      const result = await request<T>(path, {
        method,
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": entry.key },
      });
      pending.current.delete(identity);
      try {
        sessionStorage.removeItem(entry.storage);
      } catch {
        /* optional storage */
      }
      setNotice(success);
      return result;
    } catch (e) {
      setError(e as Error);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        pending.current.delete(identity);
        if (entry)
          try {
            sessionStorage.removeItem(entry.storage);
          } catch {
            /* optional storage */
          }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return {
    run,
    busy,
    error,
    notice,
    clear,
  };
}
