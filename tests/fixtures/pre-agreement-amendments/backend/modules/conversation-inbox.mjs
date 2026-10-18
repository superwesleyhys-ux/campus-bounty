import { z, parse, requireThat } from "./common.mjs";
import { account } from "../db/store.mjs";
const cursorSchema = z.strictObject({
  actor: z.uuid(),
  createdAt: z.iso.datetime({ precision: 6 }),
  type: z.enum(["application", "agreement", "order"]),
  id: z.uuid(),
});
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export function inboxQuery(actor, input) {
  const d = parse(
    z.strictObject({
      limit: z
        .string()
        .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
        .default("30"),
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
  if (d.cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(d.cursor, "base64url").toString("utf8"));
    } catch {
      /* validation below */
    }
    cursor = parse(cursorSchema, decoded);
    requireThat(
      cursor.actor === actor && encode(decoded) === d.cursor,
      422,
      "invalid_input",
      "The cursor belongs to a different inbox.",
    );
  }
  return { limit: Number(d.limit), cursor };
}
export function conversationInboxModule(store) {
  return {
    conversationInbox: async (actor, input) => {
      const { limit, cursor } = inboxQuery(actor, input);
      return store.as(actor, async (c) => {
        await c.query("SELECT id FROM campus.users WHERE id=$1 FOR SHARE", [
          actor,
        ]);
        await account(c, actor);
        // The app-role transaction applies the same live RLS as each conversation.
        // Catalog joins are also RLS-filtered; expired membership gets safe labels.
        const rows = (
          await c.query(
            `WITH scopes AS (
        SELECT a.id,'application'::text AS type,a.state,a.created_at, t.title,
          CASE WHEN a.applicant_id=$1 THEN 'Applicant' ELSE 'Publisher or proposed participant' END AS role
        FROM campus.applications a LEFT JOIN campus.tasks t ON t.id=a.task_id AND campus.is_member()
        WHERE campus.can_read_application_conversation(a.id)
        UNION ALL
        SELECT a.id,'agreement',a.state,a.created_at,t.title,'Signed collaboration'
        FROM campus.agreements a LEFT JOIN campus.tasks t ON t.id=a.task_id AND campus.is_member()
        UNION ALL
        SELECT o.id,'order',o.state,o.created_at,p.title,
          CASE WHEN o.buyer_id=$1 THEN 'Buyer' ELSE 'Seller' END
        FROM campus.orders o LEFT JOIN campus.products p ON p.id=o.product_id AND campus.is_member()
      ) SELECT id,type,state,title,role,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM scopes WHERE ($2::timestamptz IS NULL OR (created_at,type,id)<($2::timestamptz,$3::text,$4::uuid))
      ORDER BY created_at DESC,type DESC,id DESC LIMIT $5`,
            [
              actor,
              cursor?.createdAt ?? null,
              cursor?.type ?? null,
              cursor?.id ?? null,
              limit + 1,
            ],
          )
        ).rows;
        const items = rows.slice(0, limit),
          last = items.at(-1);
        return {
          items,
          limit,
          nextCursor:
            rows.length > limit
              ? encode({
                  actor,
                  createdAt: last.createdAt,
                  type: last.type,
                  id: last.id,
                })
              : null,
        };
      });
    },
  };
}
