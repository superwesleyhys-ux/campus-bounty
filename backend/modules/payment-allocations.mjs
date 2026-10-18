import { randomUUID } from "node:crypto";
import {
  z,
  parse,
  uuid,
  found,
  requireThat,
  context,
  lockTask,
} from "./common.mjs";
import { account, member, idempotent } from "../db/store.mjs";
import { Problem } from "../errors.mjs";
import { componentPlan, ratios } from "../payments/amounts.mjs";
export const allocationProposalSchema = z.strictObject({
  expectedTermsVersion: z.number().int().positive().max(2147483646),
  expectedRevision: z.number().int().positive().max(2147483646),
  expectedAllocationRevision: z.number().int().min(0).max(2147483646),
  ratios: z
    .array(
      z.strictObject({
        userId: z.uuid(),
        ratioUnits: z.number().int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(100),
  ratioDenominator: z.literal(10000),
  policyVersionId: z.uuid().nullable(),
});
export const allocationRevisionSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(2147483646);
export const allocationConfirmationSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(2147483646),
  expectedTermsVersion: z.number().int().positive().max(2147483646),
  allocationDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function transactionCapabilities(c) {
  const p = (
    await c.query(
      "SELECT to_regprocedure('campus.transaction_terms_capabilities()') IS NOT NULL AS present",
    )
  ).rows[0].present;
  const value = p
    ? (await c.query("SELECT campus.transaction_terms_capabilities() AS value"))
        .rows[0].value
    : {
        transactionTerms: false,
        transactionSchemaRequirement: 18,
        financialExecution: false,
        feeEstimate: "pending_policy",
      };
  return {
    ...value,
    payments: (
      await c.query(
        "SELECT to_regprocedure('campus.money_capabilities()') IS NOT NULL AS present",
      )
    ).rows[0].present
      ? (await c.query("SELECT campus.money_capabilities() AS result")).rows[0]
          .result
      : {
          enabled: false,
          environment: "unavailable",
          schemaRequirement: 20,
          policyReadiness: "pending_decisions",
          providerReadiness: "unverified",
        },
  };
}
export async function transactionSql(c, sql, args) {
  try {
    return await c.query(sql, args);
  } catch (e) {
    if (["P0001", "42501"].includes(e.code) && /^[a-z_]+$/.test(e.message))
      throw new Problem(
        e.message === "not_found"
          ? 404
          : e.message.startsWith("invalid_") ||
              e.message === "fee_exceeds_component"
            ? 422
            : 409,
        e.message,
        "Review current transaction terms and required confirmations. No funds were moved.",
      );
    throw e;
  }
}
async function available(c) {
  requireThat(
    (await transactionCapabilities(c)).transactionTerms,
    503,
    "transaction_terms_unavailable",
    "Transaction terms are unavailable on this schema.",
  );
}
async function projection(c, id, input = {}) {
  const query = parse(
    z.strictObject({
      beforeRevision: z.coerce
        .number()
        .int()
        .positive()
        .max(2147483646)
        .optional(),
    }),
    input,
  );
  await available(c);
  const app = found(
    (await c.query("SELECT * FROM campus.applications WHERE id=$1", [id]))
      .rows[0],
  );
  const task = found(
    (await c.query("SELECT * FROM campus.tasks WHERE id=$1", [app.task_id]))
      .rows[0],
  );
  const page = (
    await c.query(
      "SELECT * FROM campus.application_allocation_revisions WHERE application_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT 21",
      [id, query.beforeRevision ?? null],
    )
  ).rows;
  const history = page.slice(0, 20),
    historyNext = page.length > 20 ? history.at(-1).revision : null;
  const current = query.beforeRevision
    ? ((
        await c.query(
          "SELECT * FROM campus.application_allocation_revisions WHERE application_id=$1 ORDER BY revision DESC LIMIT 1",
          [id],
        )
      ).rows[0] ?? null)
    : (history[0] ?? null);
  const confirmations = (
    await c.query(
      "SELECT * FROM campus.application_allocation_confirmations WHERE application_id=$1 AND allocation_id=ANY($2::uuid[]) ORDER BY allocation_revision DESC,user_id",
      [
        id,
        [
          ...new Set([
            ...history.map((r) => r.id),
            ...(current ? [current.id] : []),
          ]),
        ],
      ],
    )
  ).rows;
  const members = (
    await c.query("SELECT * FROM campus.application_people($1)", [id])
  ).rows;
  const policies = (
    await c.query(
      "SELECT id,status,provenance,payload,campus.transaction_policy_disclosure_valid(payload) AS disclosure_ready FROM campus.payment_policy_versions WHERE application_id=$1 AND listing_version=$2 ORDER BY created_at DESC",
      [id, task.terms_version],
    )
  ).rows;
  const blockedReasons = [];
  if (!task.release_policy)
    blockedReasons.push("transaction_terms_not_enabled");
  if (!current) blockedReasons.push("allocation_required");
  if (
    current &&
    (current.listing_version !== task.terms_version ||
      current.task_revision !== task.revision)
  )
    blockedReasons.push("stale_allocation_revision");
  if (!current?.policy_id)
    blockedReasons.push(
      "fee_policy_pending",
      "fee_adjustment_policy_pending",
      "tax_policy_pending",
      "refund_policy_pending",
    );
  const selectedPolicy = policies.find((p) => p.id === current?.policy_id);
  const financialConsentAvailable = !!(
    current?.policy_snapshot &&
    selectedPolicy?.status === "approved" &&
    selectedPolicy.disclosure_ready &&
    (
      await c.query(
        "SELECT $1::jsonb=jsonb_build_object('policyId',$2::uuid,'provenance',$3::text,'payload',$4::jsonb) AS valid",
        [
          current.policy_snapshot,
          selectedPolicy.id,
          selectedPolicy.provenance,
          selectedPolicy.payload,
        ],
      )
    ).rows[0].valid
  );
  if (current?.policy_id && !financialConsentAvailable)
    blockedReasons.push("policy_disclosure_pending");
  const required = [...members.map((m) => m.user_id), task.owner_id];
  if (
    !current ||
    required.some(
      (id) =>
        !confirmations.some(
          (c) =>
            c.allocation_id === current.id &&
            c.user_id === id &&
            c.consent_kind === "financial_terms",
        ),
    )
  )
    blockedReasons.push("financial_consent_required");
  return {
    applicationId: id,
    applicantId: app.applicant_id,
    publisherId: task.owner_id,
    state: app.state,
    releasePolicy: task.release_policy ?? null,
    termsVersion: task.terms_version,
    taskRevision: task.revision,
    members,
    current,
    history,
    historyNext,
    confirmations,
    policies,
    blockedReasons,
    financialExecution: false,
    financialConsentAvailable,
  };
}
export async function agreementTransactionProjection(c, id) {
  if (!(await transactionCapabilities(c)).transactionTerms)
    return {
      releasePolicy: null,
      provenance: "not_recorded",
      financialExecution: false,
    };
  const bindings = (
    await c.query(
      "SELECT * FROM campus.agreement_transaction_bindings WHERE agreement_id=$1 ORDER BY terms_revision",
      [id],
    )
  ).rows;
  const terms = (
    await c.query(
      "SELECT * FROM campus.agreement_transaction_terms WHERE agreement_id=$1 ORDER BY revision",
      [id],
    )
  ).rows;
  const allocations = (
    await c.query(
      "SELECT * FROM campus.payee_allocations WHERE agreement_id=$1 ORDER BY stage_position,member_id",
      [id],
    )
  ).rows;
  return {
    releasePolicy: terms.at(-1)?.release_policy ?? null,
    provenance: terms.length ? "exact_allocation" : "not_recorded",
    bindings,
    terms,
    allocations,
    financialExecution: false,
  };
}
export function paymentAllocationModule(store) {
  async function command(actor, id, input, key, confirm, revision) {
    uuid(id);
    const d = parse(
      confirm ? allocationConfirmationSchema : allocationProposalSchema,
      input,
    );
    if (confirm) revision = parse(allocationRevisionSchema, revision);
    return store.as(actor, async (c) => {
      await account(c, actor);
      await available(c);
      const app = found(
        (
          await c.query("SELECT task_id FROM campus.applications WHERE id=$1", [
            id,
          ])
        ).rows[0],
      );
      await lockTask(c, app.task_id);
      await member(c, actor, { write: true });
      let replayed = true;
      const receipt = await idempotent(
        c,
        actor,
        `allocation.${confirm ? "confirm:" + revision : "propose"}:${id}`,
        key,
        d,
        async () => {
          replayed = false;
          let body = d;
          if (confirm) {
            const current = found(
              (
                await c.query(
                  "SELECT * FROM campus.application_allocation_revisions WHERE application_id=$1 AND revision=$2",
                  [id, revision],
                )
              ).rows[0],
            );
            body = {
              allocationId: current.id,
              expectedAllocationRevision: revision,
              digest: d.allocationDigest,
              consentKind: current.policy_id
                ? "financial_terms"
                : "ratios_only",
              expectedTermsVersion: d.expectedTermsVersion,
              expectedRevision: d.expectedRevision,
            };
          }
          if (!confirm) {
            let members;
            try {
              members = ratios(
                d.ratios.map((r) => ({
                  memberId: r.userId,
                  units: r.ratioUnits,
                })),
              );
            } catch {
              throw new Problem(
                422,
                "invalid_ratios",
                "Ratios must name the frozen recipients and sum to 10000.",
              );
            }
            const stages = (
              await c.query(
                "SELECT position,amount_cents FROM campus.task_milestones WHERE task_id=$1 ORDER BY position",
                [app.task_id],
              )
            ).rows;
            let fee = null;
            if (d.policyVersionId) {
              const p = found(
                (
                  await c.query(
                    "SELECT payload FROM campus.payment_policy_versions WHERE id=$1 AND application_id=$2 AND status='approved'",
                    [d.policyVersionId, id],
                  )
                ).rows[0],
              );
              fee = p.payload.estimatedProcessorFeeCents;
            }
            let plan;
            try {
              plan = componentPlan({
                members,
                lots: [
                  {
                    fundingPlanLotId: randomUUID(),
                    estimatedProcessorFeeCents: fee,
                    stages: stages.map((s) => ({
                      position: s.position,
                      milestoneId: `position:${s.position}`,
                      grossCents: s.amount_cents,
                    })),
                  },
                ],
              });
            } catch (e) {
              throw new Problem(
                422,
                e.code ?? "invalid_component_plan",
                "This fee cannot be allocated without negative member amounts.",
              );
            }
            body = {
              expectedTermsVersion: d.expectedTermsVersion,
              expectedRevision: d.expectedRevision,
              expectedAllocationRevision: d.expectedAllocationRevision,
              policyId: d.policyVersionId,
              ratios: members,
              plan,
            };
          }
          return (
            await transactionSql(
              c,
              `SELECT campus.${confirm ? "confirm_application_allocation" : "propose_application_allocation"}($1,$2) AS result`,
              [id, JSON.stringify(body)],
            )
          ).rows[0].result;
        },
      );
      await member(c, actor, { write: true });
      return { receipt, replayed, current: await projection(c, id) };
    });
  }
  return {
    applicationAllocation: (actor, id, input = {}) => {
      uuid(id);
      return context(store).privateRead(actor, (c) => projection(c, id, input));
    },
    proposeAllocation: (a, id, d, k) => command(a, id, d, k, false),
    confirmAllocation: (a, id, r, d, k) => command(a, id, d, k, true, r),
  };
}
