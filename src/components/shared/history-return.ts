"use client";
import { useEffect, useRef, type MouseEvent, type RefObject } from "react";

// One in-memory return target, scoped to the actor and exact list query. No
// private record contents, credentials, or cross-account browser storage.
export function useHistoryReturn(
  main: RefObject<HTMLElement | null>,
  actor: string | undefined,
  route: string,
) {
  const previousActor = useRef(actor);
  const target = useRef<{
    actor: string;
    route: string;
    item: string;
    href: string;
    expires: number;
  } | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(route);
    const view = query.get("view") || "bounties";
    if (actor !== previousActor.current) target.current = null;
    previousActor.current = actor;
    const saved = target.current;
    const returning =
      actor &&
      saved?.actor === actor &&
      saved.route === route &&
      saved.expires > Date.now() &&
      !query.has("id") &&
      !window.location.hash;
    if (!query.has("id") || window.location.hash) target.current = null;

    const eligibility =
      view === "account" && window.location.hash === "#student-eligibility"
        ? document.getElementById("student-eligibility")
        : null;
    (eligibility || main.current)?.focus({ preventScroll: true });
    if (eligibility) eligibility.scrollIntoView();
    else window.scrollTo({ top: 0 });
    if (!returning || !saved || !main.current) return;

    let cancelled = false,
      frame = 0;
    const cancel = () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
    const focusChanged = (event: FocusEvent) => {
      if (event.target !== main.current && event.target !== document.body)
        cancel();
    };
    const restore = () => {
      if (cancelled) return;
      if (Date.now() >= saved.expires) {
        cancel();
        return;
      }
      const ready = [
        ...main.current!.querySelectorAll<HTMLElement>("[data-history-ready]"),
      ].some((node) => node.dataset.historyReady === route);
      if (!ready) return;
      observer.disconnect();
      frame = requestAnimationFrame(() => {
        if (cancelled || window.location.hash) return;
        const card = [
          ...main.current!.querySelectorAll<HTMLElement>("[data-history-item]"),
        ].find((node) => node.dataset.historyItem === saved.item);
        if (!card) return; // Removed or no longer authorized: do not revive it.
        const links = [...card.querySelectorAll<HTMLAnchorElement>("a[href]")];
        const link =
          links.find((node) => node.getAttribute("href") === saved.href) ||
          links[0];
        const focus = link || card;
        // Detach before our own focus event; user input during loading cancels.
        document.removeEventListener("focusin", focusChanged);
        focus.focus({ preventScroll: true });
        card.scrollIntoView({ block: "center" });
      });
    };
    const observer = new MutationObserver(restore);
    observer.observe(main.current, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-history-ready"],
    });
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("wheel", cancel, { passive: true });
    document.addEventListener("focusin", focusChanged);
    restore();
    return () => {
      cancel();
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("wheel", cancel);
      document.removeEventListener("focusin", focusChanged);
    };
  }, [actor, route, main]);

  return (event: MouseEvent<HTMLElement>) => {
    if (
      !actor ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const query = new URLSearchParams(route);
    if (
      query.has("id") ||
      !["workspace", "saved"].includes(query.get("view") || "")
    )
      return;
    const clicked = event.target instanceof Element ? event.target : null;
    const link = clicked?.closest<HTMLAnchorElement>("a[href]");
    const card = link?.closest<HTMLElement>("[data-history-item]");
    if (!link || !card?.dataset.historyItem) return;
    const destination = new URL(link.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      !destination.searchParams.has("id")
    )
      return;
    target.current = {
      actor,
      route,
      item: card.dataset.historyItem,
      href: link.getAttribute("href")!,
      expires: Date.now() + 15 * 60 * 1000,
    };
  };
}
