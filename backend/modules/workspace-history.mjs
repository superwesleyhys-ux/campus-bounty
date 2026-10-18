import { agreementProjection } from "./agreement-amendments.mjs";
import { z, parse, requireThat, uuid, empty, found } from "./common.mjs";
import { account, member } from "../db/store.mjs";

export const historyScopes = [
  "applications",
  "agreements",
  "orders",
  "posted",
  "selling",
  "saved",
];
const scopeSchema = z.enum(historyScopes);
const cursorSchema = z.strictObject({
  actor: z.uuid(),
  scope: scopeSchema,
  createdAt: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export function historyHttpQuery(request) {
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
export function historyQuery(actor, input) {
  const p = parse(
    z.strictObject({
      scope: scopeSchema,
      limit: z
        .string()
        .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
        .default("20"),
      cursor: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    }),
    input,
  );
  let cursor = null;
  if (p.cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(p.cursor, "base64url").toString("utf8"));
    } catch {
      /* validated below */
    }
    cursor = parse(cursorSchema, decoded);
    requireThat(
      cursor.actor === actor &&
        cursor.scope === p.scope &&
        encode(decoded) === p.cursor,
      422,
      "invalid_input",
      "The cursor belongs to a different account or list. Return to newest records.",
    );
  }
  return { scope: p.scope, limit: Number(p.limit), cursor };
}
// Each query runs as campus_app. Private history keeps the existing DTO and RLS;
// catalog joins explicitly require membership even when a task is actor-owned.
const queries = {
  applications: {
    select: `a.*,t.title AS task_title,coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',m.user_id,'display_name',m.display_name,'confirmed',m.confirmed) ORDER BY m.user_id) FROM campus.application_people(a.id) m),'[]'::jsonb) AS members`,
    from: `campus.applications a LEFT JOIN campus.tasks t ON t.id=a.task_id AND campus.is_member()`,
    where: `(a.applicant_id=$1 OR EXISTS(SELECT 1 FROM campus.application_members m WHERE m.application_id=a.id AND m.user_id=$1))`,
  },
  agreements: {
    select: `a.*,(SELECT jsonb_build_object('pending',count(*) FILTER(WHERE m.state='pending'),'submitted',count(*) FILTER(WHERE m.state='submitted'),'revision_requested',count(*) FILTER(WHERE m.state='revision_requested'),'accepted',count(*) FILTER(WHERE m.state='accepted'),'total',count(*)) FROM campus.milestones m WHERE m.agreement_id=a.id) AS milestone_counts`,
    from: `campus.agreements a`,
    where: `$1::uuid IS NOT NULL`,
  },
  orders: {
    select: `a.id,a.product_id,a.buyer_id,a.seller_id,a.total_cents,a.delivery_method,a.state,a.reserved_until,a.terms,a.created_at`,
    from: `campus.orders a`,
    where: `$1::uuid IS NOT NULL`,
  },
  posted: {
    select: `a.id,a.owner_id,a.title,a.category,a.description,a.reward_cents,to_char(a.due_date,'YYYY-MM-DD') AS due_date,a.status,a.visibility,a.terms_version,a.revision,a.created_at`,
    from: `campus.tasks a`,
    where: `a.owner_id=$1`,
  },
  selling: {
    select: `a.id,a.seller_id,a.title,a.description,a.price_cents,a.stock,a.delivery_methods,a.shipping_cents,a.visibility,a.terms_version,a.stock_revision,a.revision,a.created_at`,
    from: `campus.products a`,
    where: `a.seller_id=$1`,
  },
  saved: {
    select: `a.*,to_char(a.due_date,'YYYY-MM-DD') AS due_date`,
    from: `campus.tasks a JOIN campus.saved s ON s.task_id=a.id`,
    where: `s.user_id=$1`,
  },
};
export function workspaceHistoryModule(store) {
  return {
    savedTaskState: async (actor, id, input = {}) => {
      uuid(id);
      parse(empty, input);
      return store.as(actor, async (c) => {
        await account(c, actor);
        await member(c, actor);
        return found(
          (
            await c.query(
              `SELECT t.id,EXISTS(SELECT 1 FROM campus.saved s WHERE s.user_id=$1 AND s.task_id=t.id) AS saved
           FROM campus.tasks t WHERE t.id=$2`,
              [actor, id],
            )
          ).rows[0],
        );
      });
    },
    workspaceHistory: async (actor, input) => {
      const { scope, limit, cursor } = historyQuery(actor, input);
      return store.as(actor, async (c) => {
        await account(c, actor);
        if (["posted", "selling", "saved"].includes(scope))
          await member(c, actor);
        const q = queries[scope];
        const rows = (
          await c.query(
            `SELECT ${q.select},
          to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "historyCreatedAt"
          FROM ${q.from} WHERE ${q.where}
          AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2::timestamptz,$3::uuid))
          ORDER BY a.created_at DESC,a.id DESC LIMIT $4`,
            [actor, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
          )
        ).rows;
        if (scope === "agreements")
          for (let i = 0; i < rows.length; i++)
            rows[i] = await agreementProjection(c, rows[i]);
        const page = rows.slice(0, limit),
          last = page.at(-1);
        return {
          scope,
          limit,
          items: page.map(({ historyCreatedAt, ...item }) => item),
          nextCursor:
            rows.length > limit
              ? encode({
                  actor,
                  scope,
                  createdAt: last.historyCreatedAt,
                  id: last.id,
                })
              : null,
        };
      });
    },
  };
}
