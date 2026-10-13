export type ConversationScope = "agreementId" | "orderId" | "applicationId";
export type ConversationParticipant = {
  id: string;
  displayName: string;
  role:
    | "publisher"
    | "captain"
    | "participant"
    | "buyer"
    | "seller"
    | "applicant"
    | "proposed_participant";
};
export type ConversationMessage = {
  id: string;
  body: string;
  createdAt: string;
  author: ConversationParticipant | null;
};
export type ConversationPage = {
  scope: { type: "agreement" | "order" | "application"; id: string };
  participants: ConversationParticipant[];
  participantCount: number;
  participantLimit: 100;
  applicationContext?: ApplicationConversationContext;
  nextParticipantCursor: string | null;
  items: ConversationMessage[];
  nextCursor: string | null;
  limit: number;
};
export type ConversationParticipantsPage = {
  scope: ConversationPage["scope"];
  items: ConversationParticipant[];
  participantCount: number;
  limit: number;
  nextCursor: string | null;
};
export function mergeMessages(
  old: ConversationMessage[],
  incoming: ConversationMessage[],
) {
  const byId = new Map(old.map((m) => [m.id, m]));
  incoming.forEach((m) => byId.set(m.id, m));
  // The API supplies fixed-width UTC microseconds. Date would lose precision.
  return [...byId.values()].sort((a, b) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id.localeCompare(b.id),
  );
}
export const conversationRole = (role: ConversationParticipant["role"]) =>
  ({
    publisher: "Publisher",
    captain: "Captain",
    participant: "Signed participant",
    buyer: "Buyer",
    seller: "Seller",
    applicant: "Applicant",
    proposed_participant: "Proposed participant",
  })[role];

export type ConversationSearchPage = {
  scope: ConversationPage["scope"];
  q: string;
  items: ConversationMessage[];
  limit: number;
  nextCursor: string | null;
};
export type MessageContextWindow = {
  scope: ConversationPage["scope"];
  message: ConversationMessage;
  older: ConversationMessage[];
  newer: ConversationMessage[];
  contextLimit: 10;
  hasOlder: boolean;
  hasNewer: boolean;
};

export type ApplicationConversationContext = {
  applicationId: string;
  applicationState:
    | "applied"
    | "invited"
    | "withdrawn"
    | "declined"
    | "superseded"
    | "accepted";
  taskStatus: "open" | "contracted" | "closed";
  canSend: boolean;
  sendUnavailableReason:
    | null
    | "account_restricted"
    | "membership_required"
    | "application_closed"
    | "task_closed";
  agreementId: string | null;
};
