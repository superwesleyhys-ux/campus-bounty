import type { Account, Team, TeamContext } from "./types";

export type TeamSummary = Omit<Team, "members" | "context">;
export const emptyTeamContext: TeamContext = {
  purpose: "",
  activities: "",
  timeCommitment: "",
  projectContext: "",
};
export function cleanTeamContext(context: TeamContext): TeamContext {
  return {
    purpose: context.purpose.trim(),
    activities: context.activities.trim(),
    timeCommitment: context.timeCommitment.trim(),
    projectContext: context.projectContext.trim(),
  };
}
export function hasTeamContext(context: TeamContext | null | undefined) {
  return !!(
    context?.purpose.trim() &&
    context.activities.trim() &&
    context.timeCommitment.trim()
  );
}
export type TeamActionKind =
  | "accept"
  | "decline"
  | "leave"
  | "revoke"
  | "remove"
  | "transfer"
  | "archive"
  | "invite";
export type TeamAction = {
  kind: TeamActionKind;
  path: string;
  body: { expectedRevision: number; userId?: string };
  title: string;
  description: string;
  targetId: string;
  targetName: string;
};

export const teamCommitments =
  "Changing team membership does not change the people named in existing proposals or agreements, or release anyone from those commitments.";

export function canGrowTeam(account: Account) {
  return (
    account.account_status === "active" &&
    account.can_apply &&
    account.campus_verified
  );
}

export function teamAction(
  team: Team,
  kind: TeamActionKind,
  account: Account,
  target?: { user_id: string; display_name?: string },
): TeamAction {
  const targetId = target?.user_id || account.id;
  const targetName =
    target?.display_name || (targetId === account.id ? "you" : "this teammate");
  const paths: Record<TeamActionKind, string> = {
    accept: "membership",
    decline: "membership/decline",
    leave: "membership/leave",
    revoke: `members/${targetId}/revoke`,
    remove: `members/${targetId}/remove`,
    transfer: "captain",
    archive: "archive",
    invite: "invitations",
  };
  const titles: Record<TeamActionKind, string> = {
    accept: "Accept team invitation",
    decline: "Decline invitation",
    leave: "Leave team",
    revoke: "Revoke invitation",
    remove: "Remove member",
    transfer: "Transfer captaincy",
    archive: "Archive team",
    invite: `Invite ${targetName}`,
  };
  const descriptions: Record<TeamActionKind, string> = {
    accept: `Join ${team.name}? You will still need to agree separately to each bounty proposal that names you.`,
    decline: `Decline your invitation to ${team.name}? You will not join. The captain can invite you again later.`,
    leave: `Leave ${team.name}? You will no longer be included in new team proposals. You would need a new invitation to rejoin.`,
    revoke: `Withdraw the invitation to ${targetName}? They will not be able to accept it. You can invite them again later.`,
    remove: `Remove ${targetName} from ${team.name}? They will no longer be included in new team proposals.`,
    transfer: `Make ${targetName} the captain of ${team.name}? You will stay as a member and give up team management. Only the new captain can transfer it back.`,
    archive: `Archive ${team.name}? The team will remain in your history and cannot receive invitations or make new proposals. It cannot be reopened here.`,
    invite: `Invite ${targetName} to ${team.name}? They will need to accept before joining.`,
  };
  return {
    kind,
    path: `teams/${team.id}/${paths[kind]}`,
    body: {
      expectedRevision: team.revision,
      ...(["invite", "transfer"].includes(kind) ? { userId: targetId } : {}),
    },
    title: titles[kind],
    description: descriptions[kind],
    targetId,
    targetName,
  };
}

export function teamActionObserved(action: TeamAction, team: Team) {
  if (team.revision <= action.body.expectedRevision) return false;
  if (action.kind === "archive") return team.status === "archived";
  if (action.kind === "transfer") return team.owner_id === action.targetId;
  const expected = {
    accept: "accepted",
    decline: "declined",
    leave: "left",
    revoke: "revoked",
    remove: "removed",
    invite: "invited",
  }[action.kind];
  return team.members.some(
    (member) => member.user_id === action.targetId && member.state === expected,
  );
}

export function teamActionOutcome(action: TeamAction, team: Team) {
  if (team.status === "archived")
    return "Current team status: archived. Existing proposals and agreements are unchanged.";
  if (action.kind === "transfer") {
    const captain = team.members.find(
      (member) => member.user_id === team.owner_id,
    );
    return `Current captain: ${captain?.display_name || "the recorded team captain"}. Existing agreement captains are unchanged.`;
  }
  const member = team.members.find(
    (value) => value.user_id === action.targetId,
  );
  return member
    ? `Current membership for ${action.targetName}: ${member.state}.`
    : "The request is resolved. The current team membership is shown below.";
}
