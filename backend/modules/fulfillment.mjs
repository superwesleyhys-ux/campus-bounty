import {
  amendmentSql,
  amendmentSchemaPresent,
  agreementCapabilities,
  submissionTermsProjection,
  termsProjection,
} from "./agreement-amendments.mjs";
import { z, parse, found, uuid, empty, text, context } from "./common.mjs";
import { account, idempotent } from "../db/store.mjs";
import { Problem } from "../errors.mjs";

const version = z.number().int().min(0).max(2147483647);
const revision = z.number().int().min(1).max(2147483647);
export const submissionSchema = z.strictObject({
  content: text,
  expectedVersion: version,
  expectedRevision: revision,
  expectedEffectiveTermsId: z.uuid().optional(),
  expectedEffectiveRevision: revision.optional(),
});
export const reviewSchema = z.strictObject({
  transactionTermsId: z.uuid().optional(),
  transactionTermsRevision: revision.optional(),
  submissionTermsId: z.uuid().optional(),
  submissionTermsRevision: revision.optional(),
  submissionId: z.uuid(),
  expectedVersion: version.min(1),
  expectedRevision: revision,
});
export const revisionRequestSchema = reviewSchema.extend({ feedback: text });

const errors = {
  funds_held:[409,"New work is paused while this agreement has an active financial risk hold."],
  allocation_required: [
    409,
    "The applicant must propose recipient allocations.",
  ],
  fee_policy_pending: [
    409,
    "An approved exact fee estimate and adjustment policy are required before acceptance.",
  ],
  financial_consent_required: [
    409,
    "The publisher and every recipient must confirm exact financial terms.",
  ],
  stale_allocation_revision: [
    409,
    "Refresh and confirm the current allocation revision.",
  ],
  terms_review_required: [
    409,
    "Every frozen participant must explicitly review and confirm the current terms version.",
  ],
  fresh_invitation_required: [
    409,
    "The publisher must issue a fresh invitation for the current version and revision.",
  ],
  listing_unavailable: [
    409,
    "This listing is paused or no longer available for new activity.",
  ],
  invalid_input: [422, "Request fields are invalid."],
  not_found: [404, "Resource not found."],
  account_locked: [403, "This account cannot access private resources."],
  account_restricted: [403, "An active account is required for this action."],
  membership_required: [
    403,
    "Current campus email verification is required for this action.",
  ],
  student_verification_required: [
    403,
    "Current student eligibility is required.",
  ],
  not_assignee: [403, "Only the agreed participants can submit work."],
  not_owner: [403, "Only the publisher can review or complete this agreement."],
  not_applicant: [403, "Only the applicant can withdraw this proposal."],
  not_captain: [403, "Only the invited applicant can accept."],
  funding_required: [
    409,
    "Funding must be confirmed before work is submitted or reviewed. Payments are not enabled in this preview.",
  ],
  invalid_state: [
    409,
    "This action is not available in the current agreement or milestone state.",
  ],
  stale_revision: [
    409,
    "The work or review state changed. Read the latest submission and feedback before trying again.",
  ],
  task_contracted: [409, "Another agreement already exists."],
  team_consent_required: [
    409,
    "Every proposed participant must consent to this task.",
  ],
  self_application: [
    409,
    "The publisher cannot participate in the applying team.",
  ],
  invalid_milestone_budget: [
    422,
    "Milestone amounts must equal the task reward.",
  ],
};
export async function workSql(c, sql, values) {
  try {
    return await amendmentSql(c, sql, values);
  } catch (error) {
    if (errors[error.message]) {
      const [status, detail] = errors[error.message];
      throw new Problem(status, error.message, detail);
    }
    throw error;
  }
}
async function authorize(c, actor, agreementId, operation) {
  // The SQL gate obtains the agreement lock before checking current account and
  // affiliation state. It holds those rows through any idempotency-key wait.
  await account(c, actor);
  await workSql(c, "SELECT campus.authorize_work_agreement($1,$2)", [
    agreementId,
    operation,
  ]);
}
async function snapshot(c, id, receipt) {
  const milestone = found(
    (await c.query("SELECT * FROM campus.milestones WHERE id=$1", [id]))
      .rows[0],
  );
  const hasTerms = await amendmentSchemaPresent(c);
  const boundSubmission =
    milestone.latest_submission_id && hasTerms
      ? await submissionTermsProjection(
          c,
          found(
            (
              await c.query("SELECT * FROM campus.submissions WHERE id=$1", [
                milestone.latest_submission_id,
              ])
            ).rows[0],
          ),
        )
      : null;
  const termsState = hasTerms
    ? found(
        (
          await c.query(
            "SELECT effective_terms_id FROM campus.agreement_terms_state WHERE agreement_id=$1",
            [milestone.agreement_id],
          )
        ).rows[0],
      )
    : null;
  return {
    ...(termsState
      ? {
          effectiveTerms: await termsProjection(
            c,
            milestone.agreement_id,
            termsState.effective_terms_id,
          ),
        }
      : {}),
    milestone,
    submission:
      boundSubmission ??
      (milestone.latest_submission_id
        ? found(
            (
              await c.query("SELECT * FROM campus.submissions WHERE id=$1", [
                milestone.latest_submission_id,
              ])
            ).rows[0],
          )
        : null),
    agreement: found(
      (
        await c.query("SELECT id,state FROM campus.agreements WHERE id=$1", [
          milestone.agreement_id,
        ])
      ).rows[0],
    ),
    receipt,
  };
}
export function fulfillmentModule(store) {
  const { privateRead } = context(store);
  const mutate = (operation, schema) => async (actor, id, input, key) => {
    uuid(id);
    const data = parse(schema, input);
    return store.as(actor, async (c) => {
      await account(c, actor);
      const location = found(
        (
          await c.query(
            "SELECT agreement_id FROM campus.milestones WHERE id=$1",
            [id],
          )
        ).rows[0],
      );
      const authority = operation === "submit" ? "submit" : "review";
      await authorize(c, actor, location.agreement_id, authority);
      const receipt = await idempotent(
        c,
        actor,
        `milestone.${operation}:${id}`,
        key,
        data,
        async () => {
          const hasTerms = await amendmentSchemaPresent(c);
          if (
            !hasTerms &&
            [
              data.expectedEffectiveTermsId,
              data.expectedEffectiveRevision,
              data.submissionTermsId,
              data.submissionTermsRevision,
            ].some((v) => v !== undefined)
          )
            throw new Problem(
              503,
              "agreement_amendments_unavailable",
              "Explicit agreement terms are not installed.",
            );
          if (operation === "submit") {
            const row = (
              await workSql(
                c,
                hasTerms
                  ? "SELECT campus.submit_milestone_work($1,$2,$3,$4,$5,$6) AS id"
                  : "SELECT campus.submit_milestone_work($1,$2,$3,$4) AS id",
                [
                  id,
                  data.expectedVersion,
                  data.expectedRevision,
                  data.content,
                  ...(hasTerms
                    ? [
                        data.expectedEffectiveTermsId ?? null,
                        data.expectedEffectiveRevision ?? null,
                      ]
                    : []),
                ],
              )
            ).rows[0];
            return { operation, submissionId: row.id };
          }
          const hasMoney = (
            await c.query(
              "SELECT to_regprocedure('campus.money_capabilities()') IS NOT NULL AS present",
            )
          ).rows[0].present;
          const row = (
            await workSql(
              c,
              hasMoney
                ? "SELECT campus.review_milestone_work($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id"
                : hasTerms
                  ? "SELECT campus.review_milestone_work($1,$2,$3,$4,$5,$6,$7,$8) AS id"
                  : "SELECT campus.review_milestone_work($1,$2,$3,$4,$5,$6) AS id",
              [
                id,
                data.submissionId,
                data.expectedVersion,
                data.expectedRevision,
                operation,
                data.feedback ?? "",
                ...(hasTerms
                  ? [
                      data.submissionTermsId ?? null,
                      data.submissionTermsRevision ?? null,
                      ...(hasMoney
                        ? [
                            data.transactionTermsId ?? null,
                            data.transactionTermsRevision ?? null,
                          ]
                        : []),
                    ]
                  : []),
              ],
            )
          ).rows[0];
          return {
            operation,
            submissionId: data.submissionId,
            reviewId: row.id,
          };
        },
      );
      // Recheck after the key lock as well; a stored receipt is not authority.
      await authorize(c, actor, location.agreement_id, authority);
      return snapshot(c, id, receipt);
    });
  };
  return {
    submitMilestone: mutate("submit", submissionSchema),
    requestMilestoneRevision: mutate(
      "revision_requested",
      revisionRequestSchema,
    ),
    acceptMilestone: mutate("accepted", reviewSchema),
    submissions: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) => {
        found(
          (await c.query("SELECT id FROM campus.milestones WHERE id=$1", [id]))
            .rows[0],
        );
        const rows = (
          await c.query(
            "SELECT * FROM campus.submissions WHERE milestone_id=$1 ORDER BY version",
            [id],
          )
        ).rows;
        return (await amendmentSchemaPresent(c))
          ? Promise.all(rows.map((s) => submissionTermsProjection(c, s)))
          : rows;
      });
    },
    milestoneReviews: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) => {
        found(
          (await c.query("SELECT id FROM campus.milestones WHERE id=$1", [id]))
            .rows[0],
        );
        const rows = (
          await c.query(
            "SELECT * FROM campus.milestone_reviews WHERE milestone_id=$1 ORDER BY created_at,id",
            [id],
          )
        ).rows;
        if (!(await amendmentSchemaPresent(c))) return rows;
        return Promise.all(
          rows.map(async (r) => ({
            ...r,
            submission: await submissionTermsProjection(
              c,
              found(
                (
                  await c.query(
                    "SELECT * FROM campus.submissions WHERE id=$1",
                    [r.submission_id],
                  )
                ).rows[0],
              ),
            ),
          })),
        );
      });
    },
    completeAgreement: async (actor, id, input, key) => {
      uuid(id);
      const data = parse(empty, input);
      return store.as(actor, async (c) => {
        await authorize(c, actor, id, "complete");
        const receipt = await idempotent(
          c,
          actor,
          `agreement.complete:${id}`,
          key,
          data,
          async () => {
            await workSql(c, "SELECT campus.complete_work_agreement($1)", [id]);
            return { operation: "completed", agreementId: id };
          },
        );
        await authorize(c, actor, id, "complete");
        return {
          agreement: found(
            (
              await c.query(
                "SELECT id,state FROM campus.agreements WHERE id=$1",
                [id],
              )
            ).rows[0],
          ),
          receipt,
        };
      });
    },
  };
}
