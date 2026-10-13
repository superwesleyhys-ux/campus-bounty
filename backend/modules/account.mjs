import { z, parse, uuid, found, requireThat } from "./common.mjs";
import { account, idempotent, audit } from "../db/store.mjs";
import { Problem } from "../errors.mjs";

export const profileSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  bio: z.string().trim().max(500),
});
export const eligibilityRequestSchema = z.strictObject({
  enrollmentSummary: z.string().trim().min(1).max(1000),
  attestation: z.literal(true),
});
export const eligibilityDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approved"),
    reason: z.string().trim().min(1).max(1000),
    validUntil: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(1).max(1000),
  }),
]);
const cursorSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
const pagingSchema = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(300).optional(),
};
const errors = {
  membership_required: [
    403,
    "A current verified campus membership is required to request student eligibility.",
  ],
  eligibility_current: [409, "Your student eligibility is already current."],
  eligibility_pending: [
    409,
    "You already have a pending request. Check its status before submitting again.",
  ],
  review_forbidden: [
    403,
    "This account cannot review student eligibility for this institution.",
  ],
  self_review_forbidden: [
    403,
    "You cannot review your own student eligibility request.",
  ],
  eligibility_decided: [
    409,
    "This request has already been decided. Refresh to see the recorded decision.",
  ],
  applicant_membership_changed: [
    409,
    "The applicant's current campus membership no longer matches this request. Reject it with an explanation so they can apply again.",
  ],
  invalid_eligibility_expiry: [
    422,
    "Approval must expire in the future, within 365 days, and no later than the applicant's verified campus membership.",
  ],
  invalid_eligibility_input: [422, "Request fields are invalid."],
};
async function eligibilitySql(c, sql, values) {
  try {
    return await c.query(sql, values);
  } catch (error) {
    if (errors[error.message]) {
      const [status, message] = errors[error.message];
      throw new Problem(status, error.message, message);
    }
    throw error;
  }
}
async function requestRow(c, id) {
  return found(
    (
      await c.query(
        "SELECT * FROM campus.eligibility_requests_visible() WHERE id=$1",
        [id],
      )
    ).rows[0],
  );
}
function cursor(value) {
  if (!value) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Problem(422, "invalid_input", "The page cursor is invalid.");
  }
  return parse(cursorSchema, decoded);
}
async function lockCommand(c, actor, operation, key) {
  requireThat(
    typeof key === "string" && /^[\x21-\x7e]{8,128}$/.test(key),
    400,
    "idempotency_required",
    "Provide an Idempotency-Key of 8 to 128 visible ASCII characters.",
  );
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([actor, operation, key]),
  ]);
}
export function accountModule(store, { production = false } = {}) {
  const publicAccount = (row) => ({
    ...row,
    can_review_eligibility: !production && row.can_review_eligibility,
  });
  const reviewAvailable = () =>
    requireThat(
      !production,
      403,
      "review_not_available",
      "Eligibility review is unavailable until administrator multi-factor verification is supported.",
    );
  const list = async (actor, input = {}, queue = false) => {
    if (queue) reviewAvailable();
    const p = parse(
      z.strictObject({
        ...pagingSchema,
        ...(queue
          ? {
              status: z
                .enum(["pending", "approved", "rejected", "all"])
                .default("pending"),
            }
          : {}),
      }),
      input,
    );
    const before = cursor(p.cursor);
    return store.as(actor, async (c) => {
      const me = await account(c, actor);
      requireThat(
        !queue || me.can_review_eligibility,
        403,
        "review_forbidden",
        errors.review_forbidden[1],
      );
      const rows = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor FROM campus.eligibility_requests_visible()
        WHERE ($1::boolean OR user_id=$2) AND (NOT $1::boolean OR can_review)
        AND ($3::text='all' OR status=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $6`,
          [
            queue,
            actor,
            queue ? p.status : "all",
            before?.at ?? null,
            before?.id ?? null,
            p.limit + 1,
          ],
        )
      ).rows;
      const more = rows.length > p.limit,
        visible = rows.slice(0, p.limit),
        last = visible.at(-1);
      const items = visible.map(({ created_cursor, ...row }) => ({
        ...row,
        can_review: !production && row.can_review,
      }));
      return {
        items,
        nextCursor: more
          ? Buffer.from(
              JSON.stringify({ at: last.created_cursor, id: last.id }),
            ).toString("base64url")
          : null,
      };
    });
  };
  return {
    me: (actor) =>
      store.as(actor, async (c) => publicAccount(await account(c, actor))),
    updateProfile: async (actor, input, key) => {
      const data = parse(profileSchema, input);
      return store.as(actor, async (c) => {
        await lockCommand(c, actor, "account.profile", key);
        await account(c, actor);
        await idempotent(c, actor, "account.profile", key, data, async () => {
          await c.query("SELECT id FROM campus.users WHERE id=$1 FOR UPDATE", [
            actor,
          ]);
          await account(c, actor);
          await c.query(
            "UPDATE campus.users SET display_name=$2,bio=$3 WHERE id=$1",
            [actor, data.displayName, data.bio],
          );
          await audit(c, actor, "account.profile", actor);
          return publicAccount(await account(c, actor));
        });
        // A command receipt must not cache permissions or resurrect an old name
        // after later edits. Return the current account on every retry.
        return publicAccount(await account(c, actor));
      });
    },
    myEligibilityRequests: (actor, input) => list(actor, input),
    eligibilityReviewQueue: (actor, input) => list(actor, input, true),
    eligibilityReview: async (actor, id) => {
      reviewAvailable();
      uuid(id);
      return store.as(actor, async (c) => {
        const me = await account(c, actor);
        requireThat(
          me.can_review_eligibility,
          403,
          "review_forbidden",
          errors.review_forbidden[1],
        );
        const row = await requestRow(c, id);
        requireThat(
          row.can_review,
          403,
          "review_forbidden",
          errors.review_forbidden[1],
        );
        return row;
      });
    },
    requestEligibility: async (actor, input, key) => {
      const data = parse(eligibilityRequestSchema, input);
      return store.as(actor, async (c) => {
        await lockCommand(c, actor, "eligibility.request", key);
        await account(c, actor);
        return idempotent(
          c,
          actor,
          "eligibility.request",
          key,
          data,
          async () => {
            const { id } = (
              await eligibilitySql(
                c,
                "SELECT campus.request_student_eligibility($1,$2) AS id",
                [data.enrollmentSummary, data.attestation],
              )
            ).rows[0];
            return requestRow(c, id);
          },
        );
      });
    },
    decideEligibility: async (actor, id, input, key) => {
      reviewAvailable();
      uuid(id);
      const data = parse(eligibilityDecisionSchema, input);
      return store.as(actor, async (c) => {
        await lockCommand(c, actor, "eligibility.decision:" + id, key);
        const me = await account(c, actor);
        requireThat(
          me.can_review_eligibility,
          403,
          "review_forbidden",
          errors.review_forbidden[1],
        );
        // Enforce current scope even on an idempotency replay after reviewer reassignment.
        const row = await requestRow(c, id);
        requireThat(
          row.user_id !== actor,
          403,
          "self_review_forbidden",
          errors.self_review_forbidden[1],
        );
        requireThat(
          row.can_review,
          403,
          "review_forbidden",
          errors.review_forbidden[1],
        );
        return idempotent(
          c,
          actor,
          "eligibility.decision:" + id,
          key,
          data,
          async () => {
            await eligibilitySql(
              c,
              "SELECT campus.decide_student_eligibility($1,$2,$3,$4)",
              [id, data.decision, data.reason, data.validUntil ?? null],
            );
            return requestRow(c, id);
          },
        );
      });
    },
  };
}
