import {
  transactionCapabilities,
  agreementTransactionProjection,
} from "./payment-allocations.mjs";
import {
  z,
  parse,
  uuid,
  title,
  text,
  money,
  found,
  requireThat,
  context,
} from "./common.mjs";
import { account, idempotent } from "../db/store.mjs";
import { Problem } from "../errors.mjs";

const positive = z.number().int().min(1).max(2147483647);
const criteria = text.nullable();
const date = z
  .string()
  .regex(/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === v;
  })
  .nullable();
const stageFields = {
  title,
  amountCents: money,
  deliverable: text,
  acceptanceCriteria: criteria,
};
export const amendmentTermsSchema = z.strictObject({
  taskTitle: title,
  description: text,
  dueDate: date,
  rewardCents: money,
  currency: z.literal("USD"),
  milestones: z
    .array(
      z.union([
        z.strictObject({ id: z.uuid(), position: positive, ...stageFields }),
        z.strictObject({
          clientReference: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          ...stageFields,
        }),
      ]),
    )
    .min(1)
    .max(20),
  retireMilestoneIds: z.array(z.uuid()).max(20),
});
const base = {
  expectedEffectiveTermsId: z.uuid(),
  expectedEffectiveRevision: positive,
};
export const proposeAmendmentSchema = z.strictObject({
  ...base,
  terms: amendmentTermsSchema,
  reason: text,
});
export const reviseAmendmentSchema = proposeAmendmentSchema.extend({
  expectedProposalRevision: positive,
});
export const confirmAmendmentSchema = z.strictObject({
  ...base,
  expectedProposalRevision: positive,
  proposedTermsId: z.uuid(),
  proposedTermsRevision: positive,
});
export const endAmendmentSchema = confirmAmendmentSchema.extend({
  reason: text,
});
const unavailable = () =>
  new Problem(
    503,
    "agreement_amendments_unavailable",
    "Agreement amendments are not available.",
  );
// No new table is touched until the fixed zero-argument function exists. No owner connection or import-time probe.
export async function agreementCapabilities(c) {
  const present = (
    await c.query(
      "SELECT to_regprocedure('campus.agreement_amendment_capabilities()') IS NOT NULL AS present",
    )
  ).rows[0].present;
  if (!present)
    return {
      agreementAmendments: false,
      agreementTermsBinding: "legacy",
      schemaRequirement: 17,
    };
  return (
    await c.query(
      "SELECT campus.agreement_amendment_capabilities() AS capability",
    )
  ).rows[0].capability;
}
export async function amendmentSchemaPresent(c) {
  return (
    await c.query(
      "SELECT to_regprocedure('campus.agreement_amendment_capabilities()') IS NOT NULL AS present",
    )
  ).rows[0].present;
}
const codes = {
  invalid_input: 422,
  invalid_milestone_budget: 422,
  no_change: 422,
  invalid_milestone_set: 422,
  not_found: 404,
  not_party: 403,
  not_proposer: 403,
  account_locked: 403,
  account_restricted: 403,
  funds_held:409,
  membership_required: 403,
  agreement_amendments_unavailable: 503,
  live_amendment_exists: 409,
  stale_effective_revision: 409,
  stale_proposal_revision: 409,
  protected_milestone: 409,
  stale_work: 409,
  agreement_closed: 409,
  invalid_state: 409,
  terms_refresh_required: 409,
  milestone_retired: 409,
};
export async function amendmentSql(c, sql, args = []) {
  try {
    return await c.query(sql, args);
  } catch (e) {
    if (codes[e.message])
      throw new Problem(
        codes[e.message],
        e.message,
        "Refresh the agreement and review its exact terms. Your draft can be retained.",
      );
    throw e;
  }
}
export function fundingProjection(state, baseTerms, proposed = baseTerms) {
  const delta = proposed.terms.rewardCents - baseTerms.terms.rewardCents;
  const a = new Map(baseTerms.milestones.map((m) => [m.id, m.amountCents]));
  const changed =
    proposed.milestones.length !== a.size ||
    proposed.milestones.some((m) => a.get(m.id) !== m.amountCents);
  return {
    authority: "unavailable",
    coverage: "unknown",
    agreementActivation: state,
    requirement: changed || delta ? "funding_reconciliation" : "none_for_terms",
    changeKind:
      delta > 0
        ? "increase"
        : delta < 0
          ? "decrease"
          : changed
            ? "reallocation"
            : "none",
    rewardDeltaCents: delta,
    additionalFundingCents: null,
    refundCents: null,
    allocationChanged: changed,
    canExecutePayment: false,
  };
}
export async function termsProjection(c, agreementId, termsId) {
  const row = found(
    (
      await c.query(
        "SELECT * FROM campus.agreement_terms WHERE agreement_id=$1 AND id=$2",
        [agreementId, termsId],
      )
    ).rows[0],
  );
  const milestones = (
    await c.query(
      `SELECT milestone_id AS id,position,title,amount_cents AS "amountCents",deliverable,acceptance_criteria AS "acceptanceCriteria" FROM campus.agreement_milestone_terms WHERE terms_id=$1 ORDER BY position`,
      [termsId],
    )
  ).rows;
  return {
    id: row.id,
    agreementId: row.agreement_id,
    revision: row.revision,
    origin: row.origin,
    recordedAt: row.recorded_at,
    sourceApplicationId: row.source_application_id,
    sourceListingVersion: row.source_listing_version,
    amendmentId: row.amendment_id,
    proposalRevision: row.proposal_revision,
    terms: row.terms,
    milestones,
  };
}
export async function agreementProjection(c, agreement) {
  agreement = {
    ...agreement,
    transaction: await agreementTransactionProjection(c, agreement.id),
  };
  const capabilities = await agreementCapabilities(c);
  if (!(await amendmentSchemaPresent(c)))
    return { ...agreement, ...capabilities };
  const state = found(
    (
      await c.query(
        "SELECT * FROM campus.agreement_terms_state WHERE agreement_id=$1",
        [agreement.id],
      )
    ).rows[0],
  );
  const originalTerms = await termsProjection(
      c,
      agreement.id,
      state.original_terms_id,
    ),
    effectiveTerms = await termsProjection(
      c,
      agreement.id,
      state.effective_terms_id,
    );
  const live =
    (
      await c.query(
        "SELECT id,current_proposal_revision AS \"proposalRevision\",status FROM campus.agreement_amendments WHERE agreement_id=$1 AND status IN ('pending','agreed_waiting_funds')",
        [agreement.id],
      )
    ).rows[0] ?? null;
  const stages = new Map(effectiveTerms.milestones.map((m) => [m.id, m]));
  const physical = (
    await c.query(
      "SELECT * FROM campus.milestones WHERE agreement_id=$1 ORDER BY position",
      [agreement.id],
    )
  ).rows;
  const counts = {
    pending: 0,
    submitted: 0,
    revision_requested: 0,
    accepted: 0,
    total: 0,
  };
  for (const m of physical)
    if (stages.has(m.id)) {
      counts[m.state]++;
      counts.total++;
    }
  let funding = fundingProjection(agreement.state, effectiveTerms);
  if (live) {
    const r = found(
      (
        await c.query(
          "SELECT base_terms_id,terms_id FROM campus.agreement_amendment_revisions WHERE amendment_id=$1 AND proposal_revision=$2",
          [live.id, live.proposalRevision],
        )
      ).rows[0],
    );
    funding = fundingProjection(
      agreement.state,
      await termsProjection(c, agreement.id, r.base_terms_id),
      await termsProjection(c, agreement.id, r.terms_id),
    );
  }
  return {
    ...agreement,
    ...capabilities,
    originalTerms,
    effectiveTerms,
    currentRewardCents: effectiveTerms.terms.rewardCents,
    originalRewardCents: originalTerms.terms.rewardCents,
    funding,
    amendmentSummary: live,
    milestone_counts: counts,
    ...(agreement.milestones
      ? {
          milestones: physical.map((m) => ({
            ...m,
            effectiveTerms: stages.get(m.id) ?? null,
            lifecycle: stages.has(m.id) ? "included" : "retired",
            protectedWork: m.version > 0,
          })),
        }
      : {}),
  };
}
export async function submissionTermsProjection(c, submission) {
  const s = found(
    (
      await c.query(
        "SELECT * FROM campus.submission_terms WHERE submission_id=$1",
        [submission.id],
      )
    ).rows[0],
  );
  const terms = await termsProjection(c, s.agreement_id, s.terms_id);
  return {
    ...submission,
    submissionTermsId: s.terms_id,
    submissionTermsRevision: s.terms_revision,
    termsProvenance: s.provenance,
    submissionTerms: terms,
    milestoneTerms: found(
      terms.milestones.find((m) => m.id === s.milestone_id),
    ),
  };
}
export function amendmentHttpQuery(request) {
  const params = new URL(request.url).searchParams,
    keys = [...params.keys()];
  requireThat(
    new Set(keys).size === keys.length,
    422,
    "invalid_input",
    "Query fields must not be repeated.",
  );
  return Object.fromEntries(params);
}
const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
export function amendmentPageQuery(
  actor,
  agreementId,
  stream,
  amendmentId,
  input = {},
) {
  const p = parse(
    z.strictObject({
      limit: z
        .string()
        .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
        .default("20"),
      cursor: z
        .string()
        .min(1)
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    }),
    input,
  );
  let last = null;
  if (p.cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(p.cursor, "base64url").toString("utf8"));
    } catch {}
    const field =
      stream === "amendments"
        ? "lastCreatedSequence"
        : stream === "terms"
          ? "lastRevision"
          : "lastSequence";
    const v = parse(
      z.strictObject({
        actor: z.uuid(),
        agreementId: z.uuid(),
        stream: z.literal(stream),
        amendmentId: z.uuid().nullable(),
        [field]: positive,
      }),
      decoded,
    );
    requireThat(
      v.actor === actor &&
        v.agreementId === agreementId &&
        v.amendmentId === amendmentId &&
        encode(v) === p.cursor,
      422,
      "invalid_input",
      "Cursor does not belong to this actor, resource and stream.",
    );
    last = v[field];
  }
  return { limit: Number(p.limit), last };
}
export async function amendmentDetail(
  c,
  actor,
  agreementId,
  id,
  requestedRevision,
) {
  const a = found(
    (
      await c.query(
        "SELECT * FROM campus.agreement_amendments WHERE id=$1 AND agreement_id=$2",
        [id, agreementId],
      )
    ).rows[0],
  );
  const rev = requestedRevision ?? a.current_proposal_revision;
  const r = found(
    (
      await c.query(
        "SELECT * FROM campus.agreement_amendment_revisions WHERE amendment_id=$1 AND proposal_revision=$2",
        [id, rev],
      )
    ).rows[0],
  );
  const g = found(
    (
      await c.query("SELECT id,state FROM campus.agreements WHERE id=$1", [
        agreementId,
      ])
    ).rows[0],
  );
  const baseTerms = await termsProjection(c, agreementId, r.base_terms_id),
    proposedTerms = await termsProjection(c, agreementId, r.terms_id);
  const participants = (
    await c.query(
      `SELECT p.id AS "userId",CASE WHEN p.id=g.owner_id THEN 'publisher' ELSE 'collaborator' END AS role,u.display_name AS "displayName",CASE WHEN f.user_id IS NULL THEN NULL ELSE jsonb_build_object('proposalRevision',f.proposal_revision,'termsId',f.terms_id,'confirmedAt',f.confirmed_at) END AS confirmation FROM campus.agreements g CROSS JOIN LATERAL (SELECT g.owner_id AS id UNION SELECT user_id FROM campus.agreement_members WHERE agreement_id=g.id) p LEFT JOIN campus.conversation_people('agreement',g.id) u ON u.id=p.id LEFT JOIN campus.agreement_amendment_confirmations f ON f.amendment_id=$2 AND f.proposal_revision=$3 AND f.user_id=p.id WHERE g.id=$1 ORDER BY p.id`,
      [agreementId, id, rev],
    )
  ).rows;
  const capability = await agreementCapabilities(c);
  const eligible = (
    await c.query(
      "SELECT account_status='active' AND campus.is_member() AS eligible FROM campus.users WHERE id=$1",
      [actor],
    )
  ).rows[0]?.eligible;
  const live =
    ["pending", "agreed_waiting_funds"].includes(a.status) &&
    rev === a.current_proposal_revision &&
    ["active", "awaiting_funding"].includes(g.state);
  const allowed = capability.agreementAmendments && eligible && live;
  return {
    id: a.id,
    agreementId,
    createdSequence: Number(a.created_sequence),
    proposerId: a.proposer_id,
    proposalRevision: rev,
    currentProposalRevision: a.current_proposal_revision,
    status: a.status,
    reason: r.reason,
    baseTerms,
    proposedTerms,
    changedPaths: r.changed_paths,
    addedMilestoneIds: r.added_milestone_ids,
    retiredMilestoneIds: r.retired_milestone_ids,
    participants,
    allowedActions: {
      confirm:
        !!allowed &&
        !participants.find((p) => p.userId === actor)?.confirmation,
      revise: !!allowed && a.proposer_id === actor,
      reject: !!allowed,
      withdraw: !!allowed && a.proposer_id === actor,
    },
    blockedReasons: allowed
      ? []
      : [
          !capability.agreementAmendments
            ? "agreement_amendments_unavailable"
            : !eligible
              ? "account_ineligible"
              : !live
                ? "invalid_state"
                : "",
        ],
    terminalReason: a.terminal_reason,
    funding: fundingProjection(g.state, baseTerms, proposedTerms),
  };
}
export function agreementAmendmentModule(store) {
  const { privateRead } = context(store);
  async function read(actor, id, fn) {
    uuid(id);
    return privateRead(actor, async (c) => {
      found(
        (await c.query("SELECT id FROM campus.agreements WHERE id=$1", [id]))
          .rows[0],
      );
      if (!(await amendmentSchemaPresent(c))) throw unavailable();
      return fn(c);
    });
  }
  function command(operation, schema) {
    return async (actor, agreementId, amendmentId, input, key) => {
      uuid(agreementId);
      if (amendmentId) uuid(amendmentId);
      const data = parse(schema, input);
      return store.as(actor, async (c) => {
        await account(c, actor);
        if (!(await amendmentSchemaPresent(c))) throw unavailable();
        await amendmentSql(
          c,
          "SELECT campus.authorize_agreement_amendment($1)",
          [agreementId],
        );
        if (amendmentId)
          found(
            (
              await c.query(
                "SELECT id FROM campus.agreement_amendments WHERE agreement_id=$1 AND id=$2",
                [agreementId, amendmentId],
              )
            ).rows[0],
          );
        const receipt = await idempotent(
          c,
          actor,
          `agreement.${operation}:${agreementId}:${amendmentId ?? ""}`,
          key,
          data,
          async () => {
            if (!(await agreementCapabilities(c)).agreementAmendments)
              throw unavailable();
            const name = {
              propose: "propose_agreement_amendment",
              revise: "revise_agreement_amendment",
              confirm: "confirm_agreement_amendment",
              reject: "reject_agreement_amendment",
              withdraw: "withdraw_agreement_amendment",
            }[operation];
            return (
              await amendmentSql(
                c,
                `SELECT campus.${name}($1,$2,$3) AS receipt`,
                [agreementId, amendmentId, JSON.stringify(data)],
              )
            ).rows[0].receipt;
          },
        );
        await amendmentSql(
          c,
          "SELECT campus.authorize_agreement_amendment($1)",
          [agreementId],
        );
        const g = await agreementProjection(
          c,
          found(
            (
              await c.query(
                "SELECT id,state FROM campus.agreements WHERE id=$1",
                [agreementId],
              )
            ).rows[0],
          ),
        );
        const a = await amendmentDetail(
          c,
          actor,
          agreementId,
          receipt.amendmentId,
        );
        return {
          agreement: { id: g.id, state: g.state },
          effectiveTerms: {
            id: g.effectiveTerms.id,
            revision: g.effectiveTerms.revision,
          },
          amendment: {
            id: a.id,
            proposalRevision: a.proposalRevision,
            status: a.status,
          },
          receipt,
          funding: a.funding,
        };
      });
    };
  }
  async function page(actor, id, stream, aid, input) {
    if (aid) uuid(aid);
    const p = amendmentPageQuery(actor, id, stream, aid, input);
    return read(actor, id, async (c) => {
      if (aid)
        found(
          (
            await c.query(
              "SELECT id FROM campus.agreement_amendments WHERE id=$1 AND agreement_id=$2",
              [aid, id],
            )
          ).rows[0],
        );
      const [table, column, field] =
        stream === "terms"
          ? ["agreement_terms", "revision", "lastRevision"]
          : stream === "amendments"
            ? [
                "agreement_amendments",
                "created_sequence",
                "lastCreatedSequence",
              ]
            : ["agreement_amendment_events", "sequence", "lastSequence"];
      const rows = (
        await c.query(
          `SELECT * FROM campus.${table} WHERE agreement_id=$1 AND ($2::integer IS NULL OR ${column}<$2) ${aid ? "AND amendment_id=$4" : ""} ORDER BY ${column} DESC LIMIT $3`,
          [id, p.last, p.limit + 1, ...(aid ? [aid] : [])],
        )
      ).rows;
      const selected = rows.slice(0, p.limit);
      let items = [];
      for (const row of selected)
        items.push(
          stream === "terms"
            ? await termsProjection(c, id, row.id)
            : stream === "amendments"
              ? await amendmentDetail(c, actor, id, row.id)
              : {
                  id: row.id,
                  agreementId: row.agreement_id,
                  amendmentId: row.amendment_id,
                  proposalRevision: row.proposal_revision,
                  sequence: row.sequence,
                  actorId: row.actor_id,
                  operation: row.operation,
                  oldStatus: row.old_status,
                  newStatus: row.new_status,
                  reason: row.reason,
                  occurredAt: row.occurred_at,
                },
        );
      const s = found(
        (
          await c.query(
            "SELECT effective_terms_id FROM campus.agreement_terms_state WHERE agreement_id=$1",
            [id],
          )
        ).rows[0],
      );
      return {
        items,
        nextCursor:
          rows.length > p.limit
            ? encode({
                actor,
                agreementId: id,
                stream,
                amendmentId: aid,
                [field]: Number(selected.at(-1)[column]),
              })
            : null,
        limit: p.limit,
        effectiveTermsId: s.effective_terms_id,
      };
    });
  }
  const propose = command("propose", proposeAmendmentSchema);
  return {
    capabilities: (actor) =>
      privateRead(actor, async (c) => ({
        ...(await agreementCapabilities(c)),
        ...(await transactionCapabilities(c)),
      })),
    proposeAmendment: (a, g, b, k) => propose(a, g, null, b, k),
    reviseAmendment: command("revise", reviseAmendmentSchema),
    confirmAmendment: command("confirm", confirmAmendmentSchema),
    rejectAmendment: command("reject", endAmendmentSchema),
    withdrawAmendment: command("withdraw", endAmendmentSchema),
    agreementTerms: (a, g, q = {}) => page(a, g, "terms", null, q),
    agreementAmendments: (a, g, q = {}) => page(a, g, "amendments", null, q),
    amendmentEvents: (a, g, m, q = {}) => page(a, g, "events", m, q),
    agreementTermsRevision: (a, g, r) =>
      read(a, g, async (c) => {
        const rev = parse(z.coerce.number().int().min(1), r);
        const row = found(
          (
            await c.query(
              "SELECT id FROM campus.agreement_terms WHERE agreement_id=$1 AND revision=$2",
              [g, rev],
            )
          ).rows[0],
        );
        return termsProjection(c, g, row.id);
      }),
    agreementAmendment: (a, g, m, q = {}) => {
      uuid(m);
      const p = parse(
        z.strictObject({
          proposalRevision: z.coerce.number().int().min(1).optional(),
        }),
        q,
      );
      return read(a, g, (c) => amendmentDetail(c, a, g, m, p.proposalRevision));
    },
  };
}
