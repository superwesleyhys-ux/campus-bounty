"use client";
import { useEffect, useRef } from "react";
// History arrives asynchronously. Resolve only DOM anchors inside this authorized
// agreement, open previous versions, and focus the exact event for keyboard users.
export function FulfillmentAnchor({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let focused = "";
    const focus = () => {
      const hash = window.location.hash.slice(1);
      if (
        hash === focused ||
        !/^(milestone|submission|review)-[a-f0-9-]{36}$/i.test(hash)
      )
        return;
      const target = root.current?.querySelector<HTMLElement>(`[id="${hash}"]`);
      if (!target) return;
      let parent = target.parentElement;
      while (parent && parent !== root.current) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      focused = hash;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
    };
    const observer = new MutationObserver(focus);
    if (root.current)
      observer.observe(root.current, { childList: true, subtree: true });
    const changed = () => {
      focused = "";
      focus();
    };
    window.addEventListener("hashchange", changed);
    // Let the enclosing route's initial focus settle before exact targeting.
    const frame = requestAnimationFrame(focus);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  return <div ref={root}>{children}</div>;
}
