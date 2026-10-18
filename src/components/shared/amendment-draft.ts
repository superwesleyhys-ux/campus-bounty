"use client";
import { useEffect, useState } from "react";
import type { AmendmentDraft } from "./amendment-types";
// Page-lifetime owner survives editor unmount. Keys include actor, agreement and
// proposal/create context; a null tombstone prevents older storage resurrecting
// an explicitly cleared or successfully published draft when storage is denied.
const pageDrafts = new Map<string, AmendmentDraft | null>();
export function useAmendmentDraft(
  account: string,
  agreement: string,
  context: string,
) {
  const key = `campus:amendment-draft:${account}:${agreement}:${context}`;
  const [draft, setState] = useState<AmendmentDraft | null>(null),
    [ready, setReady] = useState(false);
  useEffect(() => {
    let value = pageDrafts.get(key) ?? null;
    if (!pageDrafts.has(key))
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) || "null");
        if (
          saved?.base?.agreementId === agreement &&
          Array.isArray(saved.stages)
        )
          value = saved;
      } catch {}
    pageDrafts.set(key, value);
    setState(value);
    setReady(true);
  }, [key, agreement]);
  function setDraft(value: AmendmentDraft | null) {
    pageDrafts.set(key, value);
    setState(value);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch {
      /* Keep editable intent in memory when optional storage is unavailable. */
    }
  }
  return { draft, setDraft, ready };
}
