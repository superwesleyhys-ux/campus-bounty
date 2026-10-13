import { request } from "./api";
import type {
  ConversationParticipant,
  ConversationParticipantsPage,
} from "./conversation-types";

type RosterPage = Pick<
  ConversationParticipantsPage,
  "items" | "participantCount" | "nextCursor"
>;
// Author absence is meaningful only against the COMPLETE current scoped roster.
// The displayed window stays separately paginated: reading authority must not
// collapse a valid off-page author or discard the user's visible roster progress.
export async function reconcileConversationRoster(
  query: string,
  first: RosterPage,
  visibleMinimum: number,
  stillCurrent: () => boolean,
) {
  const authority = new Map<string, ConversationParticipant>();
  let page = first;
  let visible: ConversationParticipant[] = [];
  let visibleCursor: string | null = null;
  let windowComplete = false;
  const seenCursors = new Set<string>();
  for (;;) {
    if (!stillCurrent()) return null;
    if (page.participantCount !== first.participantCount)
      throw new Error(
        "Participants changed while loading. Refresh messages to check the current roster.",
      );
    page.items.forEach((person) => authority.set(person.id, person));
    if (!windowComplete) {
      visible = [...authority.values()];
      visibleCursor = page.nextCursor;
      windowComplete = visible.length >= visibleMinimum || !page.nextCursor;
    }
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor))
      throw new Error(
        "The participant list could not be verified. Refresh messages to try again.",
      );
    seenCursors.add(page.nextCursor);
    page = await request<ConversationParticipantsPage>(
      `conversations/participants?${query}&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
  }
  if (authority.size !== first.participantCount)
    throw new Error(
      "Participants changed while loading. Refresh messages to check the current roster.",
    );
  return {
    authority,
    participants: visible,
    participantCount: first.participantCount,
    nextParticipantCursor: visibleCursor,
  };
}
