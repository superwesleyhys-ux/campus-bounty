// Preserve the surrounding workspace/list context while selecting an immutable revision.
export function selectAmendmentAnchor(amendmentId: string, revision: number) {
  const url = new URL(window.location.href);
  url.searchParams.set("amendmentId", amendmentId);
  url.searchParams.set("proposalRevision", String(revision));
  url.hash = `amendment-${amendmentId}-revision-${revision}`;
  window.history.replaceState(null, "", url);
}
