import { z, parse, found, uuid, context, lockTeam } from "./common.mjs";
import { account, idempotent, audit } from "../db/store.mjs";
import { Problem } from "../errors.mjs";

export const teamRevisionSchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});
export const teamTargetSchema = teamRevisionSchema.extend({ userId: z.uuid() });
export const teamContextSchema = z.strictObject({
  purpose: z.string().trim().min(1).max(1000),
  activities: z.string().trim().min(1).max(1500),
  timeCommitment: z.string().trim().min(1).max(500),
  projectContext: z.string().trim().max(1500),
});
export const createTeamSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  context: teamContextSchema.optional(),
});
export const teamContextUpdateSchema = teamRevisionSchema.extend({
  context: teamContextSchema,
});
const blankContext = () => ({
  purpose: "",
  activities: "",
  timeCommitment: "",
  projectContext: "",
});
const errors = {
  invalid_input: [422, "Request fields are invalid."],
  not_found: [404, "Resource not found."],
  account_locked: [403, "This account cannot access private resources."],
  not_owner: [403, "Only the current team captain can perform this action."],
  student_verification_required: [
    403,
    "Current student eligibility is required.",
  ],
  team_revision_changed: [
    409,
    "The team changed. Refresh before trying again.",
  ],
  team_archived: [409, "This team is archived."],
  team_context_required: [
    409,
    "Add the team's purpose, planned activities, and expected time commitment before inviting someone.",
  ],
  membership_state_changed: [
    409,
    "This membership is no longer in the required state.",
  ],
  captain_transfer_required: [
    409,
    "Transfer captaincy before leaving, or archive a team with no other active members or invitations.",
  ],
  team_not_empty: [
    409,
    "Remove other accepted members and revoke pending invitations before archiving.",
  ],
};
async function teamSql(c, sql, values) {
  try {
    return await c.query(sql, values);
  } catch (error) {
    if (errors[error.message]) {
      const [status, detail] = errors[error.message];
      throw new Problem(status, error.message, detail);
    }
    throw error;
  }
}
async function teamRow(c, id) {
  const team = found(
    (await c.query("SELECT * FROM campus.teams_visible() WHERE id=$1", [id]))
      .rows[0],
  );
  return {
    ...team,
    context: team.can_view_roster
      ? (
          await c.query(
            'SELECT purpose,activities,time_commitment AS "timeCommitment",project_context AS "projectContext" FROM campus.team_contexts WHERE team_id=$1',
            [id],
          )
        ).rows[0] || blankContext()
      : null,
    members: (
      await c.query("SELECT * FROM campus.team_people($1) ORDER BY user_id", [
        id,
      ])
    ).rows,
  };
}
export function teamModule(store) {
  const { privateRead } = context(store);
  const change =
    (operation, targetInBody = false, targetInPath = false) =>
    async (actor, id, ...args) => {
      uuid(id);
      const [target, input, key] = targetInPath ? args : [null, ...args];
      if (targetInPath) uuid(target);
      const data = parse(
        targetInBody ? teamTargetSchema : teamRevisionSchema,
        input,
      );
      return store.as(actor, async (c) => {
        await lockTeam(c, id);
        await account(c, actor);
        await idempotent(
          c,
          actor,
          `team.${operation}:${id}${targetInPath ? ":" + target : ""}`,
          key,
          data,
          async () => {
            await teamSql(c, "SELECT campus.change_team($1,$2,$3,$4)", [
              id,
              operation,
              targetInBody ? data.userId : targetInPath ? target : actor,
              data.expectedRevision,
            ]);
            await audit(c, actor, "team." + operation, id);
            // Persist only identity, never a roster or a permission snapshot.
            return { id };
          },
        );
        return teamRow(c, id);
      });
    };
  return {
    teams: (actor) =>
      privateRead(
        actor,
        async (c) =>
          (
            await c.query(
              "SELECT * FROM campus.teams_visible() ORDER BY name,id",
            )
          ).rows,
      ),
    team: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) => {
        await lockTeam(c, id);
        return teamRow(c, id);
      });
    },
    teamCandidate: async (actor, id, input) => {
      uuid(id);
      const { userId } = parse(z.strictObject({ userId: z.uuid() }), input);
      return privateRead(actor, async (c) =>
        found(
          (
            await c.query(
              "SELECT user_id,display_name FROM campus.team_candidate($1,$2)",
              [id, userId],
            )
          ).rows[0],
        ),
      );
    },
    createTeam: async (actor, input, key) => {
      const data = parse(createTeamSchema, input);
      return store.as(actor, async (c) => {
        await account(c, actor);
        const receipt = await idempotent(
          c,
          actor,
          "team.create",
          key,
          data,
          async () => {
            const { id } = (
              await teamSql(
                c,
                "SELECT campus.create_team_with_context($1,$2) AS id",
                [data.name, data.context ? JSON.stringify(data.context) : null],
              )
            ).rows[0];
            await audit(c, actor, "team.create", id);
            return { id };
          },
        );
        await lockTeam(c, receipt.id);
        return teamRow(c, receipt.id);
      });
    },
    updateTeamContext: async (actor, id, input, key) => {
      uuid(id);
      const data = parse(teamContextUpdateSchema, input);
      return store.as(actor, async (c) => {
        await lockTeam(c, id);
        await account(c, actor);
        await idempotent(
          c,
          actor,
          `team.context:${id}`,
          key,
          data,
          async () => {
            // The definer records every actual change, including direct SQL calls.
            await teamSql(c, "SELECT campus.set_team_context($1,$2,$3)", [
              id,
              data.expectedRevision,
              JSON.stringify(data.context),
            ]);
            return { id };
          },
        );
        return teamRow(c, id);
      });
    },
    inviteMember: change("invite", true),
    acceptMembership: change("accept"),
    declineMembership: change("decline"),
    leaveTeam: change("leave"),
    revokeInvitation: change("revoke", false, true),
    removeMember: change("remove", false, true),
    transferCaptain: change("captain", true),
    archiveTeam: change("archive"),
  };
}
