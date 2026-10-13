import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Account, Team } from "./types";
import { Feedback, Field } from "./ui";
import {
  canGrowTeam,
  cleanTeamContext,
  emptyTeamContext,
  hasTeamContext,
} from "./team-types";
import { useTeamRequest } from "./team-request";
import { TeamContextFields } from "./team-context";

export function TeamCreate({
  account,
  onCreated,
}: {
  account: Account;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [context, setContext] = useState({ ...emptyTeamContext });
  const [notice, setNotice] = useState("");
  const mutation = useTeamRequest(account.id);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice) result.current?.focus();
  }, [notice]);
  async function create() {
    if (!canGrowTeam(account) || !hasTeamContext(context)) return;
    setNotice("");
    const current = await mutation.send<Team>("teams", {
      name: name.trim(),
      context: cleanTeamContext(context),
    });
    if (current) {
      setName("");
      setContext({ ...emptyTeamContext });
      setNotice(
        current.status === "archived"
          ? `${current.name} is archived. Existing proposals and agreements are unchanged.`
          : current.owner_id === account.id
            ? `${current.name} is active. You are the captain and can invite collaborators.`
            : current.own_state === "accepted"
              ? `${current.name} is active. You are a team member; the current captain manages invitations.`
              : `${current.name}: your membership is ${current.own_state}. Your membership history is shown in your teams.`,
      );
      onCreated();
    }
  }
  return (
    <div className="cb-panel">
      <h2>Create a team</h2>
      {!canGrowTeam(account) ? (
        <p>
          Reviewed student eligibility and an active account are required before
          you can create or join a team.{" "}
          <Link href="/?view=account#student-eligibility">
            Check student eligibility
          </Link>
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <p className="cb-muted">
            Team background is visible to current members and invited teammates.
          </p>
          <Field label="Team name">
            <input
              name="name"
              required
              maxLength={100}
              value={name}
              disabled={mutation.unresolved}
              onChange={(event) => setName(event.target.value)}
              placeholder="Campus research collective"
            />
          </Field>
          <TeamContextFields
            value={context}
            onChange={setContext}
            disabled={mutation.unresolved}
          />
          <Feedback error={mutation.error} />
          {mutation.phase === "unknown" && (
            <p role="status">
              The team may already have been created. Its original name and
              request are saved here. Retry the same request to retrieve the
              result without creating a second team.
            </p>
          )}
          <button
            type="submit"
            className="cb-button cb-primary"
            disabled={
              mutation.busy ||
              (!mutation.unresolved &&
                (!name.trim() || !hasTeamContext(context)))
            }
          >
            {mutation.busy
              ? "Creating…"
              : mutation.phase === "unknown"
                ? "Retry same creation"
                : "Create team"}
          </button>
        </form>
      )}
      <div ref={result} tabIndex={-1} className="cb-team-result">
        <Feedback notice={notice} />
      </div>
    </div>
  );
}
