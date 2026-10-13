import type { Account, Team } from "./types";
import {
  canGrowTeam,
  teamAction,
  type TeamAction,
  type TeamActionKind,
} from "./team-types";
import { Status } from "./ui";

export function TeamMembers({
  team,
  account,
  disabled,
  onChoose,
}: {
  team: Team;
  account: Account;
  disabled: boolean;
  onChoose: (action: TeamAction) => void;
}) {
  const captain = team.owner_id === account.id;
  const locked = account.account_status === "locked";
  const active = team.status === "active" && team.can_view_roster;
  const actionButton = (
    kind: TeamActionKind,
    text: string,
    member?: Team["members"][number],
    unavailable = false,
  ) => (
    <button
      type="button"
      className="cb-button"
      disabled={disabled || locked || unavailable}
      onClick={() => onChoose(teamAction(team, kind, account, member))}
    >
      {text}
    </button>
  );
  return (
    <>
      {!team.can_view_roster && (
        <p>
          Your membership has ended. Only your own membership record is shown.
        </p>
      )}
      <ul className="cb-members cb-team-members">
        {team.members.map((member) => (
          <li key={member.user_id}>
            <div className="cb-team-person">
              <strong>
                {member.user_id === account.id
                  ? "You"
                  : member.display_name || "Team member"}
              </strong>
              <div className="cb-team-tags">
                <Status value={member.state} />
                {team.can_view_roster && team.owner_id === member.user_id && (
                  <span className="cb-badge">Captain</span>
                )}
              </div>
            </div>
            {active && captain && member.user_id !== account.id && (
              <div className="cb-team-actions">
                {member.state === "invited" &&
                  actionButton("revoke", "Revoke invitation", member)}
                {member.state === "accepted" && (
                  <>
                    {actionButton("remove", "Remove member", member)}
                    {actionButton(
                      "transfer",
                      "Transfer captaincy",
                      member,
                      !member.can_captain,
                    )}
                    {!member.can_captain && (
                      <small>
                        This member needs current student eligibility to become
                        captain.
                      </small>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {active && (
        <div className="cb-team-actions">
          {team.own_state === "invited" && (
            <>
              {actionButton(
                "accept",
                "Accept team invitation",
                undefined,
                !canGrowTeam(account),
              )}
              {actionButton("decline", "Decline invitation")}
            </>
          )}
          {team.own_state === "accepted" &&
            !captain &&
            actionButton("leave", "Leave team")}
          {captain &&
            team.members.every(
              (member) =>
                member.user_id === account.id ||
                !["accepted", "invited"].includes(member.state),
            ) &&
            actionButton("archive", "Archive team")}
        </div>
      )}
      {active &&
        captain &&
        team.members.some(
          (member) =>
            member.user_id !== account.id &&
            ["accepted", "invited"].includes(member.state),
        ) && (
          <p className="cb-muted">
            To leave, transfer captaincy to an eligible member first. To
            archive, remove other members and revoke pending invitations.
          </p>
        )}
      {active && locked && (
        <p>Your account is locked. Team changes are unavailable.</p>
      )}
      {active && team.own_state === "invited" && !canGrowTeam(account) && (
        <p>
          Current student eligibility is required to accept. You can decline
          while your account is not locked.
        </p>
      )}
    </>
  );
}
