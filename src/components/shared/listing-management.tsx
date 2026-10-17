"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Account } from "./types";
import {
  type Listing,
  type ListingKind,
  type ListingReceipt,
  type CommandResult,
  listingPath,
  type ListingVersion,
} from "./listing-types";
import { useListingRequest } from "./listing-request";
import { ApiError, useResource } from "./api";
import { ConfirmAction } from "./confirm-action";
import { Feedback, ResourceState } from "./ui";
import { ListingEventVersion } from "./listing-event-version";
import { TermsView } from "./listing-terms";
export function ListingManagement({
  listing,
  kind,
  account,
  reload,
}: {
  listing: Listing;
  kind: ListingKind;
  account: Account;
  reload: () => void;
}) {
  const query = useSearchParams(),
    owner =
      ("owner_id" in listing ? listing.owner_id : listing.seller_id) ===
      account.id;
  const command = useListingRequest<CommandResult<ListingReceipt, Listing>>(
    `${account.id}:${kind}:${listing.id}:visibility`,
  );
  const [before, setBefore] = useState<number | undefined>(),
    [history, setHistory] = useState(false);
  const versions = useResource<ListingVersion[]>(
    history
      ? `${listingPath(kind, listing.id)}/versions?limit=5${before ? `&beforeVersion=${before}` : ""}`
      : null,
  );
  const editLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (location.hash === "#listing-management") editLink.current?.focus();
  }, []);
  const edit = new URLSearchParams(query.toString());
  edit.set("edit", "1");
  const op = listing.visibility === "paused" ? "republish" : "pause";
  const stale =
    command.error instanceof ApiError && command.error.status === 409;
  return (
    <section
      className="cb-panel"
      id="listing-management"
      tabIndex={-1}
      aria-label="Listing management"
    >
      <h2>Listing visibility and versions</h2>
      <p>
        {listing.visibility === "paused"
          ? "Paused — unavailable for new applications or purchases"
          : "Published"}{" "}
        · version {listing.terms_version} · revision {listing.revision}
      </p>
      <p>Existing agreements and orders continue with their original terms.</p>
      {owner && (
        <div className="cb-actions">
          {command.pending ? (
            <span>Resolve the pending visibility request before editing.</span>
          ) : (
            <Link ref={editLink} className="cb-button" href={`/?${edit}`}>
              {kind === "task" ? "Edit bounty" : "Edit listing"}
            </Link>
          )}
          <ConfirmAction
            label={
              command.pending
                ? "Recover visibility request"
                : op === "pause"
                  ? "Pause listing"
                  : "Republish listing"
            }
            description={
              command.pending
                ? "The previous visibility request may have completed. Recover the same original request; the current listing may have changed."
                : op === "pause"
                  ? "Remove this listing from public browsing and stop new applications or purchases. Existing agreements, orders and reservations continue."
                  : "Show this listing in public browsing again. Existing agreements and orders keep their terms. Applications require a fresh version-specific invitation."
            }
            confirmLabel={
              command.pending
                ? "Recover visibility receipt"
                : op === "pause"
                  ? "Confirm pause"
                  : "Confirm republish"
            }
            cancelLabel="Keep current visibility"
            busy={command.busy}
            disabled={
              !command.ready ||
              stale ||
              (!command.pending &&
                op === "republish" &&
                "status" in listing &&
                listing.status !== "open")
            }
            uncertain={!!command.pending}
            onCheckStatus={reload}
            onConfirm={async () => {
              const r = await command.send(
                `${listingPath(kind, listing.id)}/${op}`,
                { expectedRevision: listing.revision },
              );
              if (r) {
                reload();
              }
              return !!r;
            }}
          />
        </div>
      )}
      <Feedback error={command.error} />
      {stale && (
        <button
          className="cb-button"
          onClick={() => {
            command.clear();
            reload();
          }}
        >
          Reload visibility before reviewing again
        </button>
      )}
      {command.result && (
        <p role="status">
          {command.result.replayed ? "Recovered original result" : "Confirmed"}:{" "}
          {command.result.receipt.visibility}, revision{" "}
          {command.result.receipt.revision}. Current state:{" "}
          {command.result.current.visibility}, revision{" "}
          {command.result.current.revision}.
        </p>
      )}
      <ListingEventVersion kind={kind} id={listing.id} />
      <button className="cb-text-button" onClick={() => setHistory(!history)}>
        {history ? "Hide version history" : "View version history"}
      </button>
      {history && (
        <>
          <ResourceState {...versions} />
          {versions.data?.map((v) => (
            <details key={v.version}>
              <summary>
                Version {v.version}
                {v.provenance === "legacy_observed_current"
                  ? " · observed at migration"
                  : ""}
              </summary>
              {v.provenance === "legacy_observed_current" && (
                <p>
                  This snapshot records terms observed at migration, not proven
                  historical submission terms.
                </p>
              )}
              <TermsView terms={v.terms} />
            </details>
          ))}
          {versions.data?.length === 5 && (
            <button
              className="cb-button"
              onClick={() => setBefore(versions.data!.at(-1)!.version)}
            >
              Older versions
            </button>
          )}
          {before && (
            <button className="cb-button" onClick={() => setBefore(undefined)}>
              Latest versions
            </button>
          )}
        </>
      )}
    </section>
  );
}
