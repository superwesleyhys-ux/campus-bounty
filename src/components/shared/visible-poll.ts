"use client";
import { useEffect, useRef, useState } from "react";
// At most one poll at a time, with no queued ticks while hidden/offline.
export function useVisiblePoll(
  read: () => Promise<boolean | undefined>,
  enabled = true,
) {
  const callback = useRef(read);
  callback.current = read;
  const [status, setStatus] = useState("Automatic updates starting…");
  useEffect(() => {
    if (!enabled) {
      setStatus("Automatic updates paused. Check your access to resume.");
      return;
    }
    let active = true,
      running = false,
      failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule(delay = 3000) {
      clearTimeout(timer);
      if (!active) return;
      if (document.hidden || !navigator.onLine) {
        setStatus(
          document.hidden
            ? "Automatic updates paused while this tab is hidden."
            : "Offline. Updates will resume when connected.",
        );
        return;
      }
      timer = setTimeout(tick, delay);
    }
    async function tick() {
      if (!active || running || document.hidden || !navigator.onLine) return;
      running = true;
      let ok: boolean | undefined;
      try {
        ok = await callback.current();
      } catch {
        ok = false;
      }
      running = false;
      if (!active) return;
      failures = ok === false ? Math.min(failures + 1, 4) : 0;
      setStatus(
        failures
          ? "Connection interrupted. Retrying automatically with backoff."
          : "Automatic updates on · checks about every 3 seconds while visible.",
      );
      schedule(failures ? Math.min(30000, 3000 * 2 ** failures) : 3000);
    }
    function resume() {
      if (!running) schedule(0);
    }
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    setStatus(
      "Automatic updates on · checks about every 3 seconds while visible.",
    );
    schedule();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [enabled]);
  return status;
}
