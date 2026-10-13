import { fulfillmentModule, workSql } from "./fulfillment.mjs";
import { member, idempotent } from "../db/store.mjs";
export {
  submissionSchema,
  reviewSchema,
  revisionRequestSchema,
} from "./fulfillment.mjs";
import {
  z,
  parse,
  found,
  requireThat,
  uuid,
  empty,
  title,
  text,
  money,
  context,
  lockTeam,
  lockTask,
  eligible,
  catalogQuery,
  searchPattern,
} from "./common.mjs";
const milestoneSchema = z.strictObject({
  title,
  amountCents: money,
  deliverable: text,
  acceptanceCriteria: text
    .nullable()
    .optional()
    .describe(
      "Explicit criteria for reviewing this milestone. Omitted or null means unspecified.",
    ),
});
export const taskSchema = z.strictObject({
  title,
  category: z.enum([
    "Research",
    "Design",
    "Engineering",
    "Writing",
    "Campus",
    "Other",
  ]),
  description: text,
  rewardCents: money,
  dueDate: z.iso
    .date()
    .regex(/^[1-9]/)
    .nullable()
    .optional()
    .describe(
      "Target delivery calendar date in YYYY-MM-DD format, years 1000 through 9999. Does not close applications or trigger cancellation.",
    ),
  milestones: z.array(milestoneSchema).min(1).max(20),
});

// The locator is immutable. State must be read only after the shared task lock,
// so accepting, inviting, consenting and terminating use one lock order.
async function lockedApplication(c, id) {
  const locator = found(
    (await c.query("SELECT task_id FROM campus.applications WHERE id=$1", [id]))
      .rows[0],
  );
  await lockTask(c, locator.task_id);
  return found(
    (await c.query("SELECT * FROM campus.applications WHERE id=$1", [id]))
      .rows[0],
  );
}

export function taskModule(store) {
  const { read, privateRead, command } = context(store);
  const terminateApplication = async (actor, id, input, key, nextState) => {
    uuid(id);
    parse(empty, input);
    const withdrawal = nextState === "withdrawn";
    return command(
      actor,
      `application.${withdrawal ? "withdraw" : "reject"}:${id}`,
      key,
      {},
      async (c) => {
        const a = await lockedApplication(c, id);
        const task = found(
          (
            await c.query("SELECT owner_id FROM campus.tasks WHERE id=$1", [
              a.task_id,
            ])
          ).rows[0],
        );
        requireThat(
          withdrawal ? a.applicant_id === actor : task.owner_id === actor,
          403,
          withdrawal ? "not_applicant" : "not_owner",
          withdrawal
            ? "Only the applicant can withdraw this proposal or decline its invitation."
            : "Only the publisher can reject this application.",
        );
        if (a.state === nextState) return { id, state: nextState };
        requireThat(
          ["applied", "invited"].includes(a.state),
          409,
          "invalid_state",
          "Only an active application or invitation can be ended. Signed agreements cannot be withdrawn here.",
        );
        await workSql(c, "SELECT campus.change_application_state($1,$2)", [
          id,
          nextState,
        ]);
        return { id, state: nextState };
      },
    );
  };
  return {
    tasks: async (actor, input) => {
      const p = catalogQuery(input, true);
      return read(actor, async (c) => {
        const where =
          "WHERE (title ILIKE $1 OR description ILIKE $1) AND ($2::text IS NULL OR category=$2) AND ($3::uuid IS NULL OR owner_id=$3)";
        const args = [
          searchPattern(p.q),
          p.category || null,
          p.scope === "mine" ? actor : null,
        ];
        const sort = {
          recent: "created_at DESC",
          amount_asc: "reward_cents ASC",
          amount_desc: "reward_cents DESC",
        }[p.sort];
        return {
          items: (
            await c.query(
              `SELECT id,owner_id,title,category,description,reward_cents,to_char(due_date,'YYYY-MM-DD') AS due_date,status,revision,created_at FROM campus.tasks ${where} ORDER BY ${sort},id DESC LIMIT $4 OFFSET $5`,
              [...args, p.limit, p.offset],
            )
          ).rows,
          total: (
            await c.query(
              `SELECT count(*)::int AS total FROM campus.tasks ${where}`,
              args,
            )
          ).rows[0].total,
          limit: p.limit,
          offset: p.offset,
        };
      });
    },
    task: async (actor, id) => {
      uuid(id);
      return read(actor, async (c) => ({
        ...found(
          (
            await c.query(
              "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM campus.tasks WHERE id=$1",
              [id],
            )
          ).rows[0],
        ),
        related_agreement:
          (
            await c.query(
              "SELECT id,state FROM campus.agreements WHERE task_id=$1",
              [id],
            )
          ).rows[0] ?? null,
        milestones: (
          await c.query(
            "SELECT * FROM campus.task_milestones WHERE task_id=$1 ORDER BY position",
            [id],
          )
        ).rows,
      }));
    },
    publishTask: async (actor, input, key) => {
      const data = parse(taskSchema, input);
      requireThat(
        data.milestones.reduce((s, m) => s + m.amountCents, 0) ===
          data.rewardCents,
        422,
        "invalid_milestone_budget",
        "Milestone amounts must equal the task reward.",
      );
      return command(actor, "task.publish", key, data, async (c) => {
        const task = (
          await c.query(
            "INSERT INTO campus.tasks(owner_id,title,category,description,reward_cents,due_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,to_char(due_date,'YYYY-MM-DD') AS due_date",
            [
              actor,
              data.title,
              data.category,
              data.description,
              data.rewardCents,
              data.dueDate ?? null,
            ],
          )
        ).rows[0];
        for (const [i, m] of data.milestones.entries())
          await c.query(
            "INSERT INTO campus.task_milestones(task_id,position,title,amount_cents,deliverable,acceptance_criteria) VALUES($1,$2,$3,$4,$5,$6)",
            [
              task.id,
              i + 1,
              m.title,
              m.amountCents,
              m.deliverable,
              m.acceptanceCriteria ?? null,
            ],
          );
        return task;
      });
    },
    applications: async (actor, id) => {
      uuid(id);
      return privateRead(
        actor,
        async (c) =>
          (
            await c.query(
              "SELECT a.*,coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',m.display_name,'confirmed',m.confirmed) ORDER BY m.user_id) FROM campus.application_people(a.id) m),'[]'::jsonb) AS members FROM campus.applications a WHERE task_id=$1 ORDER BY created_at,id",
              [id],
            )
          ).rows,
      );
    },
    application: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) =>
        found(
          (
            await c.query(
              `SELECT a.id,a.state,a.proposal,a.created_at,
                CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id',t.id,'title',t.title) END AS task,
                coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',m.display_name,'confirmed',m.confirmed) ORDER BY m.user_id) FROM campus.application_people(a.id) m),'[]'::jsonb) AS members
               FROM campus.applications a LEFT JOIN campus.tasks t ON t.id=a.task_id AND campus.is_member() WHERE a.id=$1`,
              [id],
            )
          ).rows[0],
        ),
      );
    },
    myApplications: (actor) =>
      privateRead(
        actor,
        async (c) =>
          (
            await c.query(
              "SELECT a.*,t.title AS task_title,coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',m.display_name,'confirmed',m.confirmed) ORDER BY m.user_id) FROM campus.application_people(a.id) m),'[]'::jsonb) AS members FROM campus.applications a LEFT JOIN campus.tasks t ON t.id=a.task_id WHERE a.applicant_id=$1 OR EXISTS(SELECT 1 FROM campus.application_members m WHERE m.application_id=a.id AND m.user_id=$1) ORDER BY a.created_at DESC,a.id DESC LIMIT 100",
              [actor],
            )
          ).rows,
      ),
    apply: async (actor, id, input, key) => {
      uuid(id);
      const data = parse(
        z.strictObject({
          proposal: text,
          teamId: z.uuid().nullable().default(null),
        }),
        input,
      );
      return command(
        actor,
        "task.apply:" + id,
        key,
        data,
        async (c) => {
          await lockTask(c, id);
          const task = found(
            (await c.query("SELECT * FROM campus.tasks WHERE id=$1", [id]))
              .rows[0],
          );
          requireThat(
            task.owner_id !== actor,
            409,
            "self_application",
            "You cannot apply to your own task.",
          );
          requireThat(
            task.status === "open",
            409,
            "invalid_state",
            "This task is not open.",
          );
          let ids = [actor];
          if (data.teamId) {
            await lockTeam(c, data.teamId);
            const team = found(
              (
                await c.query("SELECT * FROM campus.teams WHERE id=$1", [
                  data.teamId,
                ])
              ).rows[0],
            );
            requireThat(
              team.owner_id === actor,
              403,
              "not_captain",
              "Only the team captain can apply.",
            );
            requireThat(
              team.status === "active",
              409,
              "team_archived",
              "This team is archived. Choose an active team or apply individually.",
            );
            ids = (
              await c.query(
                "SELECT user_id FROM campus.team_members WHERE team_id=$1 AND state='accepted' ORDER BY user_id",
                [data.teamId],
              )
            ).rows.map((r) => r.user_id);
          }
          requireThat(
            !ids.includes(task.owner_id),
            409,
            "self_application",
            "The task publisher cannot join the applying team.",
          );
          await eligible(c, ids);
          requireThat(
            !(
              await c.query(
                "SELECT 1 FROM campus.applications WHERE task_id=$1 AND applicant_id=$2 AND state IN ('applied','invited','accepted')",
                [id, actor],
              )
            ).rowCount,
            409,
            "already_applied",
            "You already applied to this task.",
          );
          const app = (
            await c.query(
              "INSERT INTO campus.applications(task_id,applicant_id,team_id,proposal) VALUES($1,$2,$3,$4) RETURNING *",
              [id, actor, data.teamId, data.proposal],
            )
          ).rows[0];
          await workSql(c, "SELECT campus.initialize_application_members($1)", [
            app.id,
          ]);
          return app;
        },
        true,
      );
    },
    consentApplication: async (actor, id, input, key) => {
      uuid(id);
      parse(empty, input);
      return command(
        actor,
        "application.consent:" + id,
        key,
        {},
        async (c) => {
          const a = await lockedApplication(c, id);
          requireThat(
            a.state === "applied",
            409,
            "invalid_state",
            "This proposal is already locked.",
          );
          await workSql(c, "SELECT campus.consent_application_member($1)", [
            id,
          ]);
          return { id, confirmed: true };
        },
        true,
      );
    },
    withdrawApplication: (actor, id, input, key) =>
      terminateApplication(actor, id, input, key, "withdrawn"),
    rejectApplication: (actor, id, input, key) =>
      terminateApplication(actor, id, input, key, "declined"),
    inviteApplicant: async (actor, id, input, key) => {
      uuid(id);
      parse(empty, input);
      return command(actor, "application.invite:" + id, key, {}, async (c) => {
        const a = await lockedApplication(c, id);
        const task = found(
          (await c.query("SELECT * FROM campus.tasks WHERE id=$1", [a.task_id]))
            .rows[0],
        );
        requireThat(
          task.owner_id === actor,
          403,
          "not_owner",
          "Only the publisher can invite applicants.",
        );
        requireThat(
          task.status === "open" && a.state === "applied",
          409,
          "invalid_state",
          "This application cannot be invited.",
        );
        const members = (
          await c.query(
            "SELECT * FROM campus.application_members WHERE application_id=$1",
            [id],
          )
        ).rows;
        requireThat(
          members.length > 0 && members.every((m) => m.confirmed),
          409,
          "team_consent_required",
          "Every proposed team member must consent to this task.",
        );
        await eligible(
          c,
          members.map((m) => m.user_id),
        );
        await workSql(
          c,
          "SELECT campus.change_application_state($1,'invited')",
          [id],
        );
        return { id, state: "invited" };
      });
    },
    acceptInvitation: async (actor, id, input, key) => {
      uuid(id);
      parse(empty, input);
      return store.as(actor, async (c) => {
        await member(c, actor, { write: true, apply: true });
        await lockedApplication(c, id);
        await member(c, actor, { write: true, apply: true });
        const receipt = await idempotent(
          c,
          actor,
          "application.accept:" + id,
          key,
          {},
          async () => {
            return (
              await workSql(
                c,
                "SELECT campus.accept_task_invitation($1) AS id",
                [id],
              )
            ).rows[0];
          },
        );
        await member(c, actor, { write: true, apply: true });
        return found(
          (
            await c.query("SELECT * FROM campus.agreements WHERE id=$1", [
              receipt.id,
            ])
          ).rows[0],
        );
      });
    },
    agreements: (actor) =>
      privateRead(
        actor,
        async (c) =>
          (
            await c.query(
              `SELECT a.*, (SELECT jsonb_build_object('pending',count(*) FILTER(WHERE m.state='pending'),'submitted',count(*) FILTER(WHERE m.state='submitted'),'revision_requested',count(*) FILTER(WHERE m.state='revision_requested'),'accepted',count(*) FILTER(WHERE m.state='accepted'),'total',count(*)) FROM campus.milestones m WHERE m.agreement_id=a.id) AS milestone_counts FROM campus.agreements a ORDER BY created_at DESC,id DESC LIMIT 100`,
            )
          ).rows,
      ),
    agreement: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) => ({
        ...found(
          (await c.query("SELECT * FROM campus.agreements WHERE id=$1", [id]))
            .rows[0],
        ),
        members: (
          await c.query(
            "SELECT user_id FROM campus.agreement_members WHERE agreement_id=$1 ORDER BY user_id",
            [id],
          )
        ).rows,
        milestones: (
          await c.query(
            "SELECT * FROM campus.milestones WHERE agreement_id=$1 ORDER BY position",
            [id],
          )
        ).rows,
      }));
    },
    ...fulfillmentModule(store),
  };
}
