import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "./api";
import type { Account, Team } from "./types";
import {
  cleanTeamContext,
  emptyTeamContext,
  hasTeamContext,
} from "./team-types";
import { useTeamRequest } from "./team-request";

export type TeamContextEditorProps = {
  team: Team;
  account: Account;
  onRead: (team: Team) => void;
  onSaved: (team: Team) => void;
  onClose: () => void;
};

export function useTeamContextDraft({
  team,
  account,
  onRead,
  onSaved,
  onClose,
}: TeamContextEditorProps) {
  const original = useRef(team.context || { ...emptyTeamContext });
  const [draft, setDraft] = useState({ ...original.current });
  const [revision, setRevision] = useState(team.revision);
  const [discard, setDiscard] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [readError, setReadError] = useState<Error | null>(null);
  const mutation = useTeamRequest(account.id);
  const conflict = team.revision !== revision;
  const canEdit =
    team.owner_id === account.id &&
    team.status === "active" &&
    account.account_status !== "locked";
  const unknown = mutation.phase === "unknown";
  const dirty =
    JSON.stringify(cleanTeamContext(draft)) !==
    JSON.stringify(cleanTeamContext(original.current));
  const readCurrent = useCallback(async () => {
    setChecking(true);
    setReadError(null);
    try {
      onRead(await request<Team>(`teams/${team.id}`));
      setChecked(true);
    } catch (cause) {
      setReadError(
        cause instanceof Error
          ? cause
          : new Error("Unable to read the saved team background."),
      );
    } finally {
      setChecking(false);
    }
  }, [team.id, onRead]);
  useEffect(() => {
    if (
      mutation.error instanceof ApiError &&
      mutation.error.status >= 400 &&
      mutation.error.status < 500
    )
      void readCurrent();
  }, [mutation.error, readCurrent]);
  function close() {
    if (mutation.unresolved || checking) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function save() {
    if (
      checking ||
      (!unknown && (conflict || !canEdit || !hasTeamContext(draft)))
    )
      return;
    const current = await mutation.send<Team>(`teams/${team.id}/context`, {
      expectedRevision: revision,
      context: cleanTeamContext(draft),
    });
    if (current) onSaved(current);
  }
  function rebase() {
    setRevision(team.revision);
    mutation.resolve();
  }
  return {
    draft,
    setDraft,
    discard,
    setDiscard,
    checking,
    checked,
    readError,
    mutation,
    conflict,
    canEdit,
    unknown,
    readCurrent,
    close,
    save,
    rebase,
  };
}
