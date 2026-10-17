import type { ConversationParticipant } from "./conversation-types";
export type Notification = {
  id: string;
  kind: string;
  templateVersion: 1;
  title: string;
  description: string;
  contextLabel: string | null;
  listingContext: null | {
    kind: "task" | "product";
    id: string;
    termsVersion: number;
    revision: number;
  };
  workContext: null | {
    type: "milestone";
    milestoneId: string;
    milestoneTitle: string;
    milestonePosition: number;
    submissionId: string;
    submissionVersion: number;
    milestoneRevision: number;
    reviewId: string | null;
  };
  navigationAnchor: null | {
    type: "milestone";
    milestoneId: string;
    submissionId: string;
    reviewId: string | null;
  };
  messageContext: null | {
    messageId: string;
    createdAt: string;
    author: ConversationParticipant | null;
    preview: string;
    truncated: boolean;
  };
  createdAt: string;
  readAt: string | null;
  target: null | {
    type: "application" | "agreement" | "order" | "team" | "eligibility";
    id: string;
    taskId?: string;
  };
  targetAvailable: boolean;
};
export type NotificationPage = {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
  limit: number;
};
export function notificationHref(item: Notification): string | null {
  if (!item.targetAvailable || !item.target) return null;
  const target = item.target;
  const id = encodeURIComponent(target.id);
  const message =
    item.kind === "message.received" && item.messageContext
      ? `&messageId=${encodeURIComponent(item.messageContext.messageId)}`
      : "";
  const listing = item.listingContext
    ? `&listingId=${encodeURIComponent(item.listingContext.id)}&listingVersion=${item.listingContext.termsVersion}`
    : "";
  switch (target.type) {
    case "application":
      if (listing)
        return `/?view=workspace&tab=applications&resource=application&id=${id}${listing}`;
      if (item.kind === "message.received")
        return `/?view=workspace&tab=applications&resource=application&id=${id}${message}`;
      return target.taskId
        ? `/?view=bounties&id=${encodeURIComponent(target.taskId)}#application-${id}`
        : `/?view=workspace&tab=applications&resource=application&id=${id}#application-${id}`;
    case "agreement":
      return `/?view=workspace&tab=agreements&resource=agreement&id=${id}${message}${item.navigationAnchor?.type === "milestone" ? `#${item.navigationAnchor.reviewId ? "review" : "submission"}-${encodeURIComponent(item.navigationAnchor.reviewId || item.navigationAnchor.submissionId)}` : ""}`;
    case "order":
      return `/?view=workspace&tab=orders&resource=order&id=${id}${message}${listing}`;
    case "team":
      return `/?view=teams#team-${id}`;
    case "eligibility":
      return "/?view=account#student-eligibility";
  }
}
