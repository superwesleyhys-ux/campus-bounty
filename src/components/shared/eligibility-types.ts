"use client";
import { useState } from "react";
import { ApiError, useResource } from "./api";

export type EligibilityRequest = {
  id: string;
  user_id: string;
  display_name: string;
  institution_id: string;
  institution_name: string;
  enrollment_summary: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
  review_reason: string | null;
  valid_until: string | null;
  affiliation_valid_until: string | null;
  can_review: boolean;
  membership_current: boolean;
};
export type EligibilityPage = {
  items: EligibilityRequest[];
  nextCursor: string | null;
};
export function eligibilityDate(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(value))
    : "Not available";
}
export function requestStatus(item: EligibilityRequest) {
  return item.status === "approved" &&
    (!item.valid_until || new Date(item.valid_until).getTime() <= Date.now())
    ? "expired"
    : item.status;
}
export function resultUncertain(error: Error | null) {
  return (
    !!error &&
    (!(error instanceof ApiError) || error.status === 0 || error.status >= 500)
  );
}
export function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function useEligibilityPages(path: string | null) {
  const [cursors, setCursors] = useState<string[]>([]);
  const first = useResource<EligibilityPage>(path);
  const cursor = cursors[cursors.length - 1];
  const current = useResource<EligibilityPage>(
    path && cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : null,
  );
  const resource = cursor ? current : first;
  return {
    ...resource,
    first,
    page: cursors.length + 1,
    previous: () => setCursors((old) => old.slice(0, -1)),
    next: () => {
      if (resource.data?.nextCursor)
        setCursors((old) => [...old, resource.data!.nextCursor!]);
    },
    reset: () => {
      setCursors([]);
      first.reload();
    },
    refresh: () => {
      first.reload();
      if (cursor) current.reload();
    },
  };
}
