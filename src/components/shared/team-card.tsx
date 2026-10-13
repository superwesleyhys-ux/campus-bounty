import { useEffect, useRef, useState } from "react";
import { ApiError, request, useResource } from "./api";
import type { Account, Team } from "./types";
import { Feedback, ResourceState, Status } from "./ui";
import { TeamConfirm } from "./team-confirm";
import { TeamInvite } from "./team-invite";
import { TeamMembers } from "./team-members";
import { TeamContextView } from "./team-context";
import { TeamContextEditor } from "./team-context-editor";
import { useTeamRequest } from "./team-request";
import {
  teamActionObserved,
  teamActionOutcome,
  type TeamAction,
  type TeamSummary,
  hasTeamContext,
} from "./team-types";

export function TeamCard({
  summary,
  account,
  refreshVersion,
  listLoading,
  onChanged,
}: {
  summary: TeamSummary;
  account: Account;
  refreshVersion: number;
  listLoading: boolean;
  onChanged: () => void;
}) {
  const resource = useResource<Team>(`teams/${summary.id}`);
  const mutation = useTeamRequest(account.id);
  const [snapshot, setSnapshot] = useState<Team>();
  const [action, setAction] = useState<TeamAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [checkError, setCheckError] = useState<Error | null>(null);
  const [checking, setChecking] = useState(false);
  const result = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const team =
    snapshot && (!resource.data || snapshot.revision > resource.data.revision)
      ? snapshot
      : resource.data;
  useEffect(() => {
    resource.reload();
  }, [refreshVersion, summary.revision, resource.reload]);
  useEffect(() => {
    if (notice) result.current?.focus();
  }, [notice]);
  useEffect(() => {
    if (
      mutation.error instanceof ApiError &&
      mutation.error.status >= 400 &&
      mutation.error.status < 500
    )
      resource.reload();
  }, [mutation.error, resource.reload]);
  const stale =
    !team ||
    listLoading ||
    resource.loading ||
    !!resource.error ||
    team.revision < summary.revision ||
    (!!action && team.revision !== action.body.expectedRevision);
  const disabled =
    editing ||
    mutation.unresolved ||
    checking ||
    listLoading ||
    resource.loading ||
    !!resource.error ||
    !team ||
    team.revision < summary.revision;

  function choose(next: TeamAction) {
    if (disabled) return;
    opener.current = document.activeElement as HTMLElement;
    mutation.resolve();
    setNotice("");
    setCheckError(null);
    setAction(next);
  }
  function cancel() {
    if (mutation.unresolved || checking) return;
    setAction(null);
    mutation.resolve();
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
      else result.current?.focus();
    });
  }
  function completed(current: Team, selected: TeamAction) {
    setSnapshot(current);
    setAction(null);
    setCheckError(null);
    setNotice(teamActionOutcome(selected, current));
    onChanged();
  }
  async function confirm() {
    if (!action || checking || (stale && mutation.phase !== "unknown")) return;
    const current = await mutation.send<Team>(action.path, action.body);
    if (current) completed(current, action);
  }
  async function check() {
    if (checking || mutation.busy) return;
    setChecking(true);
    setCheckError(null);
    try {
      const current = await request<Team>(`teams/${summary.id}`);
      setSnapshot(current);
      if (action && mutation.phase === "unknown") {
        if (teamActionObserved(action, current)) {
          mutation.resolve();
          completed(current, action);
        } else
          setCheckError(
            new Error(
              "The current state does not confirm this action. Retry the same request to resolve it safely; it will use the original request key.",
            ),
          );
      } else {
        setNotice(
          `Team refreshed. Your membership: ${current.own_state}. Team status: ${current.status}.`,
        );
        onChanged();
      }
    } catch (cause) {
      setCheckError(
        cause instanceof Error
          ? cause
          : new Error("Unable to refresh this team."),
      );
    } finally {
      setChecking(false);
    }
  }
  if (!team)
    return (
      <article className="cb-panel">
        <h2>{summary.name}</h2>
        <ResourceState {...resource} />
      </article>
    );
  const acceptedCount = team.members.filter(
    (member) => member.state === "accepted",
  ).length;
  return (
    <article className="cb-panel cb-team-card">
      <div className="cb-team-header">
        <div>
          <h2>{team.name}</h2>
          <Status value={team.status} />
        </div>
        <button
          className="cb-button"
          disabled={
            mutation.unresolved || checking || resource.loading || listLoading
          }
          onClick={check}
        >
          {checking ? "Refreshing…" : "Refresh team"}
        </button>
      </div>
      <p>
        {team.can_view_roster
          ? `${team.owner_id === account.id ? "You are the captain" : team.own_state === "invited" ? "You are invited" : "Team member"} · ${acceptedCount} accepted ${acceptedCount === 1 ? "member" : "members"}`
          : `Your membership: ${team.own_state}`}
      </p>
      <div
        ref={result}
        tabIndex={-1}
        className="cb-team-result"
        aria-label={`Update for ${team.name}`}
      >
        <Feedback notice={notice} error={!action ? checkError : null} />
      </div>
      <ResourceState
        loading={false}
        error={resource.error}
        reload={resource.reload}
      />
      {team.status === "archived" && (
        <p>
          This team is archived and cannot be used for new proposals. Existing
          proposals and agreements remain available.
        </p>
      )}
      {team.can_view_roster && <TeamContextView context={team.context} />}
      {team.status === "active" && team.owner_id === account.id && (
        <button
          className="cb-button cb-team-edit-context"
          disabled={disabled || account.account_status === "locked"}
          onClick={() => {
            opener.current = document.activeElement as HTMLElement;
            setNotice("");
            setEditing(true);
          }}
        >
          {hasTeamContext(team.context)
            ? "Edit team background"
            : "Add team background"}
        </button>
      )}
      <TeamMembers
        team={team}
        account={account}
        disabled={disabled}
        onChoose={choose}
      />
      {team.status === "active" && team.owner_id === account.id && (
        <TeamInvite
          team={team}
          account={account}
          disabled={disabled}
          onChoose={choose}
        />
      )}
      {editing && (
        <TeamContextEditor
          team={team}
          account={account}
          onRead={setSnapshot}
          onSaved={(current) => {
            setSnapshot(current);
            setEditing(false);
            setNotice(
              current.can_view_roster
                ? "The current saved team background is shown below. Existing proposals and agreements are unchanged."
                : "Your membership has ended. Team background is no longer available.",
            );
            onChanged();
          }}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        />
      )}
      {action && (
        <TeamConfirm
          action={action}
          phase={mutation.phase}
          stale={stale}
          error={checkError || mutation.error}
          checking={checking}
          onConfirm={confirm}
          onCancel={cancel}
          onCheck={check}
        />
      )}
    </article>
  );
}
