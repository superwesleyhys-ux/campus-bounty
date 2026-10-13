import { useState } from "react";
import { useResource } from "./api";
import { Field, ResourceState } from "./ui";
import type { Account, Team } from "./types";
import {
  canGrowTeam,
  hasTeamContext,
  teamAction,
  type TeamAction,
} from "./team-types";

export function TeamInvite({
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
  const [memberCode, setMemberCode] = useState("");
  const [lookup, setLookup] = useState("");
  const candidate = useResource<{ user_id: string; display_name: string }>(
    lookup
      ? `teams/${team.id}/candidates?userId=${encodeURIComponent(lookup)}`
      : null,
  );
  const eligible = canGrowTeam(account);
  const existing =
    candidate.data &&
    team.members.some(
      (member) =>
        member.user_id === candidate.data?.user_id &&
        ["accepted", "invited"].includes(member.state),
    );
  if (!hasTeamContext(team.context))
    return (
      <div className="cb-team-invite">
        <h3>Invite a teammate</h3>
        <p>
          Add the team purpose, activities and schedule, and expected time
          commitment using “Add team background” before sending new invitations.
          Existing invitations can still be accepted.
        </p>
      </div>
    );
  return (
    <form
      className="cb-team-invite"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && eligible) {
          setLookup(memberCode.trim());
          candidate.reload();
        }
      }}
    >
      <h3>Invite a teammate</h3>
      {!eligible && (
        <p>
          Current student eligibility is required to send invitations. You can
          still manage existing members while your account is not locked.
        </p>
      )}
      <Field
        label="Teammate’s member code"
        help="Ask your teammate to copy their code from the Teams page. Only approved students can join."
      >
        <input
          name="member"
          value={memberCode}
          disabled={disabled || !eligible}
          onChange={(event) => {
            setMemberCode(event.target.value);
            setLookup("");
          }}
          required
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          placeholder="Paste member code"
        />
      </Field>
      <button
        type="submit"
        className="cb-button"
        disabled={disabled || !eligible || (!!lookup && candidate.loading)}
      >
        Check teammate
      </button>
      {lookup && <ResourceState {...candidate} />}
      {lookup && candidate.data && !candidate.loading && (
        <div className="cb-team-candidate">
          <p>
            <strong>{candidate.data.display_name}</strong>
          </p>
          {existing ? (
            <p>This teammate already has a membership or invitation.</p>
          ) : (
            <>
              <p>They will need to accept before joining {team.name}.</p>
              <button
                type="button"
                className="cb-button cb-primary"
                disabled={disabled || !eligible}
                onClick={() =>
                  onChoose(teamAction(team, "invite", account, candidate.data))
                }
              >
                Invite {candidate.data.display_name}
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
