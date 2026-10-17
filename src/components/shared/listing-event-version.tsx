"use client";
import { useSearchParams } from "next/navigation";
import { useResource } from "./api";
import {
  listingPath,
  type ListingKind,
  type ListingVersion,
} from "./listing-types";
import { ResourceState } from "./ui";
import { TermsView } from "./listing-terms";
// Notification context selects an immutable, currently authorized snapshot.
// Current listing terms and original signed order/agreement terms stay separate.
export function ListingEventVersion({
  kind,
  id,
}: {
  kind: ListingKind;
  id: string;
}) {
  const query = useSearchParams(),
    version = query.get("listingVersion"),
    eventId = query.get("listingId");
  const enabled =
    eventId === id && !!version && /^[1-9][0-9]{0,8}$/.test(version);
  const resource = useResource<ListingVersion>(
    enabled ? `${listingPath(kind, id)}/versions/${version}` : null,
  );
  if (!enabled) return null;
  return (
    <section className="cb-panel" aria-label="Notification listing version">
      <h3>Notification refers to listing version {version}</h3>
      <p>
        This is the event's recorded listing snapshot. Existing signed
        agreements and orders retain their own terms.
      </p>
      <ResourceState {...resource} />
      {resource.data && (
        <details>
          <summary>Read event version {resource.data.version}</summary>
          {resource.data.provenance === "legacy_observed_current" && (
            <p>
              These terms were observed at migration; earlier displayed terms
              are unknown.
            </p>
          )}
          <TermsView terms={resource.data.terms} />
        </details>
      )}
    </section>
  );
}
