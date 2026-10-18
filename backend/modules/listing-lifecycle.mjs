import { agreementProjection } from "./agreement-amendments.mjs";
// Opt-in foundation: do not register until migration 015 has been reviewed/applied.
import {
  z,
  parse,
  found,
  requireThat,
  uuid,
  text,
  context,
  lockTask,
  lockTeam,
  eligible,
} from "./common.mjs";
import { member, account, idempotent, audit } from "../db/store.mjs";
import { Problem } from "../errors.mjs";
import { taskSchema } from "./tasks.mjs";
import { productSchema } from "./goods.mjs";
const revision = z.number().int().min(1).max(2147483646);
export const listingVisibilitySchema = z.strictObject({
  expectedRevision: revision,
});
export const taskEditSchema = z.strictObject({
  expectedRevision: revision,
  terms: taskSchema,
});
export const productEditSchema = z.strictObject({
  expectedRevision: revision,
  expectedStock: z.number().int().min(0),
  expectedStockRevision: revision,
  terms: productSchema,
});
export const termsReviewSchema = z.strictObject({
  expectedRevision: revision,
  expectedTermsVersion: revision,
});
export const versionedApplySchema = termsReviewSchema.extend({
  proposal: text,
  teamId: z.uuid().nullable().default(null),
});
const statuses = {
  not_found: 404,
  not_owner: 403,
  not_applicant: 403,
  not_captain: 403,
  membership_required: 403,
  account_restricted: 403,
  student_verification_required: 403,
  invalid_input: 422,
  invalid_milestone_budget: 422,
};
const messages = {
  stale_revision:
    "This listing changed. Keep your draft and review the current version before retrying.",
  stock_changed:
    "Available inventory changed. Reload and review stock before saving.",
  terms_review_required:
    "Every frozen participant must explicitly review and confirm the current terms version.",
  fresh_invitation_required:
    "The publisher must issue a fresh invitation for the current version and revision.",
  listing_unavailable:
    "This listing is paused or no longer available for new activity.",
  task_contracted: "This bounty cannot be reopened for another agreement.",
  invalid_milestone_budget: "Milestone amounts must equal the task reward.",
  not_found: "Resource not found.",
  not_owner: "Only the listing owner can manage it.",
  invalid_state: "This action is unavailable in the current state.",
};
export async function listingSql(c, sql, values) {
  try {
    return await c.query(sql, values);
  } catch (e) {
    if (["P0001", "42501"].includes(e.code) && /^[a-z_]+$/.test(e.message))
      throw new Problem(
        statuses[e.message] ?? 409,
        e.message,
        messages[e.message] ?? "This action is not permitted.",
      );
    if (["22007", "22008", "22P02", "22003"].includes(e.code))
      throw new Problem(422, "invalid_input", "Request fields are invalid.");
    throw e;
  }
}
const table = (k) => (k === "task" ? "tasks" : "products");
const kind = (k) => parse(z.enum(["task", "product"]), k);
async function current(c, k, id) {
  return found(
    (
      await c.query(
        `SELECT *,${k === "task" ? "to_char(due_date,'YYYY-MM-DD') AS due_date" : "stock_revision AS stock_revision"} FROM campus.${table(k)} WHERE id=$1`,
        [id],
      )
    ).rows[0],
  );
}
async function lockedCurrent(c, k, id) {
  return (
    await listingSql(c, "SELECT campus.lock_owned_listing($1,$2) AS listing", [
      k,
      id,
    ])
  ).rows[0].listing;
}
export function listingLifecycleModule(store) {
  const { privateRead } = context(store);
  async function change(actor, k, id, operation, input, key) {
    kind(k);
    uuid(id);
    const data = parse(
      operation === "edit"
        ? k === "task"
          ? taskEditSchema
          : productEditSchema
        : listingVisibilitySchema,
      input,
    );
    if (k === "task" && operation === "edit")
      requireThat(
        data.terms.milestones.reduce((s, m) => s + m.amountCents, 0) ===
          data.terms.rewardCents,
        422,
        "invalid_milestone_budget",
        messages.invalid_milestone_budget,
      );
    return store.as(actor, async (c) => {
      const row = await lockedCurrent(c, k, id);
      requireThat(
        (k === "task" ? row.owner_id : row.seller_id) === actor,
        403,
        "not_owner",
        messages.not_owner,
      );
      await member(c, actor, { write: true });
      let replayed = true;
      const receipt = await idempotent(
        c,
        actor,
        `listing.${k}.${operation}:${id}`,
        key,
        data,
        async () => {
          replayed = false;
          const result = (
            await listingSql(
              c,
              "SELECT campus.change_listing($1,$2,$3,$4,$5,$6,$7) AS result",
              [
                k,
                id,
                operation,
                data.expectedRevision,
                data.expectedStock ?? null,
                data.expectedStockRevision ?? null,
                data.terms ? JSON.stringify(data.terms) : null,
              ],
            )
          ).rows[0].result;
          return result;
        },
      );
      await member(c, actor, { write: true });
      return { receipt, replayed, current: await current(c, k, id) };
    });
  }
  async function review(actor, id, operation, input, key) {
    uuid(id);
    const data = parse(termsReviewSchema, input);
    return store.as(actor, async (c) => {
      await account(c, actor);
      const locator = found(
        (
          await c.query("SELECT task_id FROM campus.applications WHERE id=$1", [
            id,
          ])
        ).rows[0],
      );
      await lockTask(c, locator.task_id);
      await member(c, actor, { write: true, apply: operation !== "invite" });
      let replayed = true;
      const receipt = await idempotent(
        c,
        actor,
        `application.terms.${operation}:${id}`,
        key,
        data,
        async () => {
          replayed = false;
          const r = (
            await listingSql(
              c,
              "SELECT campus.review_application_terms($1,$2,$3,$4) AS result",
              [id, data.expectedTermsVersion, data.expectedRevision, operation],
            )
          ).rows[0].result;
          return r;
        },
      );
      return {
        receipt,
        replayed,
        current: await applicationReview(c, id),
        ...(receipt.agreementId
          ? {
              agreement: await agreementProjection(
                c,
                found(
                  (
                    await c.query(
                      "SELECT * FROM campus.agreements WHERE id=$1",
                      [receipt.agreementId],
                    )
                  ).rows[0],
                ),
              ),
            }
          : {}),
      };
    });
  }
  async function applicationReview(c, id) {
    const locator = found(
      (
        await c.query("SELECT task_id FROM campus.applications WHERE id=$1", [
          id,
        ])
      ).rows[0],
    );
    await lockTask(c, locator.task_id);
    const application = found(
      (
        await c.query(
          "SELECT a.*,b.submitted_version,b.provenance FROM campus.applications a JOIN campus.application_listing_terms b ON b.application_id=a.id WHERE a.id=$1",
          [id],
        )
      ).rows[0],
    );
    const listing = await current(c, "task", application.task_id);
    const versions = (
      await c.query(
        "SELECT * FROM campus.listing_versions WHERE kind='task' AND listing_id=$1 AND version=ANY($2::int[]) ORDER BY version",
        [listing.id, [application.submitted_version, listing.terms_version]],
      )
    ).rows;
    const acknowledgements = (
      await c.query(
        "SELECT user_id,version,acknowledged_at FROM campus.application_terms_acknowledgements WHERE application_id=$1 AND version=$2 ORDER BY user_id",
        [id, listing.terms_version],
      )
    ).rows;
    const members = (
      await c.query("SELECT * FROM campus.application_people($1)", [id])
    ).rows;
    const required = [
      ...new Set([application.applicant_id, ...members.map((m) => m.user_id)]),
    ];
    const missing = required.filter(
      (user) =>
        !acknowledgements.some(
          (a) => a.user_id === user && a.version === listing.terms_version,
        ),
    );
    const invitations = (
      await c.query(
        "SELECT * FROM campus.application_version_invitations WHERE application_id=$1 AND version=$2 AND task_revision=$3",
        [id, listing.terms_version, listing.revision],
      )
    ).rows;
    return {
      application,
      listing,
      versions,
      members,
      acknowledgements,
      invitations,
      missingAcknowledgements: missing,
      currentInvitation:
        invitations.find(
          (i) =>
            i.version === listing.terms_version &&
            i.task_revision === listing.revision,
        ) ?? null,
      reviewRequired: missing.length > 0,
      legacyProvenance: application.provenance !== "exact_submission",
    };
  }
  return {
    editTask: (actor, id, data, key) =>
      change(actor, "task", id, "edit", data, key),
    editProduct: (actor, id, data, key) =>
      change(actor, "product", id, "edit", data, key),
    pauseListing: (actor, k, id, data, key) =>
      change(actor, k, id, "pause", data, key),
    republishListing: (actor, k, id, data, key) =>
      change(actor, k, id, "republish", data, key),
    listingState: async (actor, k, id) => {
      kind(k);
      uuid(id);
      return privateRead(actor, (c) => current(c, k, id));
    },
    listingVersion: async (actor, k, id, version) => {
      kind(k);
      uuid(id);
      parse(revision, version);
      return privateRead(actor, async (c) =>
        found(
          (
            await c.query(
              "SELECT * FROM campus.listing_versions WHERE kind=$1 AND listing_id=$2 AND version=$3",
              [k, id, version],
            )
          ).rows[0],
        ),
      );
    },
    listingHistory: async (actor, k, id, input = {}) => {
      kind(k);
      uuid(id);
      const p = parse(
        z.strictObject({
          beforeVersion: revision.optional(),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        input,
      );
      return privateRead(actor, async (c) => {
        await current(c, k, id);
        return (
          await c.query(
            "SELECT * FROM campus.listing_versions WHERE kind=$1 AND listing_id=$2 AND ($3::int IS NULL OR version<$3) ORDER BY version DESC LIMIT $4",
            [k, id, p.beforeVersion ?? null, p.limit],
          )
        ).rows;
      });
    },
    listingCatalog: async (actor, k, input = {}) => {
      kind(k);
      const p = parse(
        z.strictObject({
          scope: z.enum(["all", "mine"]).default("all"),
          limit: z.number().int().min(1).max(100).default(30),
          offset: z.number().int().min(0).max(10000).default(0),
        }),
        input,
      );
      return store.as(actor, async (c) => {
        await member(c, actor);
        return (
          await c.query(
            `SELECT * FROM campus.${table(k)} WHERE ($1='mine' AND ${k === "task" ? "owner_id" : "seller_id"}=$2) OR ($1='all' AND visibility='published') ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
            [p.scope, actor, p.limit, p.offset],
          )
        ).rows;
      });
    },
    applicationTermsHistory: async (actor, id, input = {}) => {
      uuid(id);
      const p = parse(
        z.strictObject({
          kind: z.enum(["acknowledgements", "invitations"]),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          beforeVersion: z.coerce.number().int().min(1).optional(),
          beforeUser: z.uuid().optional(),
          beforeRevision: z.coerce.number().int().min(1).optional(),
        }),
        input,
      );
      requireThat(
        !p.beforeVersion ||
          (p.kind === "acknowledgements" ? !!p.beforeUser : !!p.beforeRevision),
        422,
        "invalid_input",
        "A complete continuation is required.",
      );
      requireThat(
        p.kind === "acknowledgements"
          ? !p.beforeRevision && (!p.beforeUser || !!p.beforeVersion)
          : !p.beforeUser && (!p.beforeRevision || !!p.beforeVersion),
        422,
        "invalid_input",
        "Use the complete continuation for this history kind.",
      );
      return privateRead(actor, async (c) => {
        found(
          (
            await c.query("SELECT id FROM campus.applications WHERE id=$1", [
              id,
            ])
          ).rows[0],
        );
        const ack = p.kind === "acknowledgements";
        const rows = (
          await c.query(
            ack
              ? p.beforeVersion
                ? "SELECT user_id,version,acknowledged_at FROM campus.application_terms_acknowledgements WHERE application_id=$1 AND (version,user_id)<($2::int,$3::uuid) ORDER BY version DESC,user_id DESC LIMIT $4"
                : "SELECT user_id,version,acknowledged_at FROM campus.application_terms_acknowledgements WHERE application_id=$1 ORDER BY version DESC,user_id DESC LIMIT $2"
              : "SELECT version,task_revision,publisher_id,created_at FROM campus.application_version_invitations WHERE application_id=$1 AND ($2::int IS NULL OR (version,task_revision)<($2,$3::int)) ORDER BY version DESC,task_revision DESC LIMIT $4",
            ack && !p.beforeVersion
              ? [id, p.limit + 1]
              : [
                  id,
                  p.beforeVersion ?? null,
                  ack ? (p.beforeUser ?? null) : (p.beforeRevision ?? null),
                  p.limit + 1,
                ],
          )
        ).rows;
        const items = rows.slice(0, p.limit),
          last = items.at(-1);
        return {
          items,
          limit: p.limit,
          next:
            rows.length > p.limit
              ? {
                  beforeVersion: last.version,
                  ...(ack
                    ? { beforeUser: last.user_id }
                    : { beforeRevision: last.task_revision }),
                }
              : null,
        };
      });
    },
    applicationTerms: async (actor, id) => {
      uuid(id);
      return privateRead(actor, (c) => applicationReview(c, id));
    },
    acknowledgeApplicationTerms: (actor, id, data, key) =>
      review(actor, id, "acknowledge", data, key),
    inviteApplicationVersion: (actor, id, data, key) =>
      review(actor, id, "invite", data, key),
    acceptApplicationVersion: (actor, id, data, key) =>
      review(actor, id, "accept", data, key),
    applyVersioned: async (actor, id, input, key) => {
      uuid(id);
      const d = parse(versionedApplySchema, input);
      return store.as(actor, async (c) => {
        await lockTask(c, id);
        await member(c, actor, { write: true, apply: true });
        let replayed = true;
        const receipt = await idempotent(
          c,
          actor,
          `task.apply.versioned:${id}`,
          key,
          d,
          async () => {
            replayed = false;
            const task = await current(c, "task", id);
            requireThat(
              task.visibility === "published" && task.status === "open",
              409,
              "listing_unavailable",
              messages.listing_unavailable,
            );
            requireThat(
              task.revision === d.expectedRevision &&
                task.terms_version === d.expectedTermsVersion,
              409,
              "stale_revision",
              messages.stale_revision,
            );
            let ids = [actor];
            if (d.teamId) {
              await lockTeam(c, d.teamId);
              const team = found(
                (
                  await c.query("SELECT * FROM campus.teams WHERE id=$1", [
                    d.teamId,
                  ])
                ).rows[0],
              );
              requireThat(
                team.owner_id === actor,
                403,
                "not_captain",
                "Only the captain can apply.",
              );
              requireThat(
                team.status === "active",
                409,
                "team_archived",
                "Choose an active team.",
              );
              ids = (
                await c.query(
                  "SELECT user_id FROM campus.team_members WHERE team_id=$1 AND state='accepted' ORDER BY user_id",
                  [d.teamId],
                )
              ).rows.map((r) => r.user_id);
            }
            requireThat(
              !ids.includes(task.owner_id),
              409,
              "self_application",
              "The publisher cannot apply.",
            );
            await eligible(c, ids);
            requireThat(
              !(
                await c.query(
                  "SELECT 1 FROM campus.applications WHERE task_id=$1 AND applicant_id=$2 AND state IN('applied','invited','accepted')",
                  [id, actor],
                )
              ).rowCount,
              409,
              "already_applied",
              "You already have an active application.",
            );
            const app = (
              await listingSql(
                c,
                "INSERT INTO campus.applications(task_id,applicant_id,team_id,proposal,submitted_terms_version,submitted_listing_revision) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
                [
                  id,
                  actor,
                  d.teamId,
                  d.proposal,
                  d.expectedTermsVersion,
                  d.expectedRevision,
                ],
              )
            ).rows[0];
            await listingSql(
              c,
              "SELECT campus.initialize_application_members($1)",
              [app.id],
            );
            await audit(c, actor, "task.apply.versioned", app.id);
            return {
              id: app.id,
              termsVersion: d.expectedTermsVersion,
              revision: d.expectedRevision,
            };
          },
        );
        return {
          receipt,
          replayed,
          current: await applicationReview(c, receipt.id),
        };
      });
    },
  };
}
