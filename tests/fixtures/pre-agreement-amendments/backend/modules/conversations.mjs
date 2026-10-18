import { createHash } from "node:crypto";
import {
  z,
  parse,
  found,
  uuid,
  empty,
  context,
  requireThat,
} from "./common.mjs";
import { account, idempotent, audit } from "../db/store.mjs";
import { Problem } from "../errors.mjs";
import { workSql } from "./fulfillment.mjs";
const scope = z.union([
  z.strictObject({ agreementId: z.uuid() }),
  z.strictObject({ orderId: z.uuid() }),
  z.strictObject({ applicationId: z.uuid() }),
]);
const token = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const scopeFields = {
  agreementId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  applicationId: z.uuid().optional(),
};
const querySchema = (maximum, fallback) =>
  z
    .strictObject({
      ...scopeFields,
      limit: z
        .string()
        .regex(
          maximum === 50
            ? /^(?:[1-9]|[1-4][0-9]|50)$/
            : /^(?:[1-9]|[1-9][0-9]|100)$/,
        )
        .default(fallback),
      cursor: token.optional(),
    })
    .refine(
      (d) =>
        Number(!!d.agreementId) +
          Number(!!d.orderId) +
          Number(!!d.applicationId) ===
        1,
    );
const timestamp = z.iso
  .datetime({ precision: 6 })
  .refine((v) => !v.startsWith("0000-"));
const cursorScope = {
  type: z.enum(["agreement", "order", "application"]),
  scopeId: z.uuid(),
};
const messageCursor = z.strictObject({
  ...cursorScope,
  kind: z.literal("messages"),
  id: z.uuid(),
  createdAt: timestamp,
});
const participantCursor = z.strictObject({
  ...cursorScope,
  kind: z.literal("participants"),
  id: z.uuid(),
});
const searchText = z
  .string()
  .trim()
  .refine(
    (value) =>
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 160 &&
      !value.includes("\0"),
    "Search text must contain 1–160 Unicode characters and no NUL.",
  );
const searchCursor = messageCursor.extend({
  kind: z.literal("search"),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const oneScope = (d) =>
  Number(!!d.agreementId) + Number(!!d.orderId) + Number(!!d.applicationId) ===
  1;
export function conversationSearchQuery(input) {
  const d = parse(
    z
      .strictObject({
        ...scopeFields,
        q: searchText,
        limit: z
          .string()
          .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
          .default("20"),
        cursor: token.optional(),
      })
      .refine(oneScope),
    input,
  );
  const type = d.agreementId
      ? "agreement"
      : d.orderId
        ? "order"
        : "application",
    scopeId = (d.agreementId || d.orderId || d.applicationId).toLowerCase();
  let cursor = null;
  if (d.cursor) {
    let value;
    try {
      value = JSON.parse(Buffer.from(d.cursor, "base64url").toString("utf8"));
    } catch {
      /* standard validation below */
    }
    cursor = parse(searchCursor, value);
    requireThat(
      cursor.type === type &&
        cursor.scopeId === scopeId &&
        encode(value) === d.cursor,
      422,
      "invalid_input",
      "The cursor does not match this search.",
    );
  }
  return {
    ...d,
    type,
    scopeId,
    limit: Number(d.limit),
    cursor,
  };
}
export function conversationMessageQuery(input) {
  const d = parse(
    z.strictObject({ ...scopeFields, messageId: z.uuid() }).refine(oneScope),
    input,
  );
  return {
    ...d,
    type: d.agreementId ? "agreement" : d.orderId ? "order" : "application",
    scopeId: (d.agreementId || d.orderId || d.applicationId).toLowerCase(),
  };
}
// Only scope enums select SQL identifiers. All request values remain parameters.
const scopeColumns = Object.freeze({
  agreement: "agreement_id",
  order: "order_id",
  application: "application_id",
});
const messageProjection = `m.id,m.body,
  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'displayName',p.display_name,'role',p.role) END AS author`;
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
export function conversationQuery(input, participants = false) {
  const d = parse(
    querySchema(participants ? 100 : 50, participants ? "100" : "30"),
    input,
  );
  const type = d.agreementId
      ? "agreement"
      : d.orderId
        ? "order"
        : "application",
    scopeId = (d.agreementId || d.orderId || d.applicationId).toLowerCase();
  let cursor = null;
  if (d.cursor) {
    let value;
    try {
      value = JSON.parse(Buffer.from(d.cursor, "base64url").toString("utf8"));
    } catch {
      /* standard validation below */
    }
    cursor = parse(participants ? participantCursor : messageCursor, value);
    requireThat(
      cursor.type === type &&
        cursor.scopeId === scopeId &&
        encode(value) === d.cursor,
      422,
      "invalid_input",
      "The cursor does not match this conversation.",
    );
  }
  return { ...d, type, scopeId, limit: Number(d.limit), cursor };
}
export function conversationHttpQuery(request) {
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
async function peoplePage(c, p, cursor = null, limit = 100) {
  if (cursor)
    requireThat(
      (
        await c.query(
          "SELECT id FROM campus.conversation_people($1,$2) WHERE id=$3",
          [p.type, p.scopeId, cursor.id],
        )
      ).rows.length === 1,
      422,
      "invalid_input",
      "The participant cursor is unavailable.",
    );
  const rows = (
    await c.query(
      `SELECT id,display_name AS "displayName",role FROM campus.conversation_people($1,$2)
     WHERE ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4`,
      [p.type, p.scopeId, cursor?.id ?? null, limit + 1],
    )
  ).rows;
  const items = rows.slice(0, limit);
  const { count } = (
    await c.query(
      "SELECT count(*)::int AS count FROM campus.conversation_people($1,$2)",
      [p.type, p.scopeId],
    )
  ).rows[0];
  return {
    items,
    participantCount: count,
    limit,
    nextCursor:
      rows.length > limit
        ? encode({
            type: p.type,
            scopeId: p.scopeId,
            kind: "participants",
            id: items.at(-1).id,
          })
        : null,
  };
}
async function requireScope(c, d) {
  if (d.agreementId)
    found(
      (
        await c.query("SELECT id FROM campus.agreements WHERE id=$1", [
          d.agreementId,
        ])
      ).rows[0],
    );
  else if (d.applicationId)
    found(
      (
        await c.query("SELECT id FROM campus.applications WHERE id=$1", [
          d.applicationId,
        ])
      ).rows[0],
    );
  else
    found(
      (await c.query("SELECT id FROM campus.orders WHERE id=$1", [d.orderId]))
        .rows[0],
    );
}
export function conversationModule(store) {
  const { read, privateRead, command } = context(store);
  const conversationRead = (actor, fn) =>
    store.as(actor, async (c) => {
      // Prevent account locking between authorization and the message/roster page.
      await c.query("SELECT id FROM campus.users WHERE id=$1 FOR SHARE", [
        actor,
      ]);
      await account(c, actor);
      return fn(c);
    });
  return {
    searchConversation: async (actor, input) => {
      const p = conversationSearchQuery(input);
      return conversationRead(actor, async (c) => {
        await requireScope(c, p);
        // Fold the original query with the same database rules as message bodies.
        // Cursor equivalence must follow that exact fold, not JavaScript casing.
        const { normalizedQuery } = (
          await c.query('SELECT lower($1::text) AS "normalizedQuery"', [p.q])
        ).rows[0];
        const queryHash = createHash("sha256")
          .update(normalizedQuery)
          .digest("hex");
        if (p.cursor)
          requireThat(
            p.cursor.queryHash === queryHash,
            422,
            "invalid_input",
            "The cursor does not match this search.",
          );
        const column = scopeColumns[p.type];
        if (p.cursor)
          requireThat(
            (
              await c.query(
                `SELECT id FROM campus.messages WHERE ${column}=$1 AND id=$2
             AND created_at=$3::timestamptz AND strpos(lower(body),$4::text)>0`,
                [p.scopeId, p.cursor.id, p.cursor.createdAt, normalizedQuery],
              )
            ).rows.length === 1,
            422,
            "invalid_input",
            "The search cursor is unavailable.",
          );
        const rows = (
          await c.query(
            `WITH people AS MATERIALIZED (SELECT * FROM campus.conversation_people($1,$2))
           SELECT ${messageProjection} FROM campus.messages m LEFT JOIN people p ON p.id=m.sender_id
           WHERE m.${column}=$2 AND strpos(lower(m.body),$3::text)>0
             AND ($4::timestamptz IS NULL OR (m.created_at,m.id)<($4::timestamptz,$5::uuid))
           ORDER BY m.created_at DESC,m.id DESC LIMIT $6`,
            [
              p.type,
              p.scopeId,
              normalizedQuery,
              p.cursor?.createdAt ?? null,
              p.cursor?.id ?? null,
              p.limit + 1,
            ],
          )
        ).rows;
        const items = rows.slice(0, p.limit),
          last = items.at(-1);
        return {
          scope: { type: p.type, id: p.scopeId },
          q: p.q,
          items,
          limit: p.limit,
          nextCursor:
            rows.length > p.limit
              ? encode({
                  type: p.type,
                  scopeId: p.scopeId,
                  kind: "search",
                  queryHash,
                  id: last.id,
                  createdAt: last.createdAt,
                })
              : null,
        };
      });
    },
    conversationMessage: async (actor, input) => {
      const p = conversationMessageQuery(input);
      return conversationRead(actor, async (c) => {
        await requireScope(c, p);
        const column = scopeColumns[p.type];
        // Target and both sides share one statement snapshot. Fetch one extra per
        // side solely for availability; the selected message is never duplicated.
        const rows = (
          await c.query(
            `WITH selected AS MATERIALIZED (
             SELECT * FROM campus.messages WHERE ${column}=$2 AND id=$3
           ), neighbors AS (
             (SELECT m.*, 'older' AS side FROM campus.messages m,selected s
              WHERE m.${column}=$2 AND (m.created_at,m.id)<(s.created_at,s.id)
              ORDER BY m.created_at DESC,m.id DESC LIMIT 11)
             UNION ALL
             (SELECT m.*, 'newer' AS side FROM campus.messages m,selected s
              WHERE m.${column}=$2 AND (m.created_at,m.id)>(s.created_at,s.id)
              ORDER BY m.created_at ASC,m.id ASC LIMIT 11)
             UNION ALL SELECT s.*, 'selected' AS side FROM selected s
           ), people AS MATERIALIZED (SELECT * FROM campus.conversation_people($1,$2))
           SELECT ${messageProjection},m.side FROM neighbors m LEFT JOIN people p ON p.id=m.sender_id
           ORDER BY m.created_at ASC,m.id ASC`,
            [p.type, p.scopeId, p.messageId],
          )
        ).rows;
        const selected = found(rows.find((row) => row.side === "selected")),
          older = rows.filter((row) => row.side === "older"),
          newer = rows.filter((row) => row.side === "newer"),
          message = ({ side, ...value }) => value;
        return {
          scope: { type: p.type, id: p.scopeId },
          message: message(selected),
          older: older.slice(-10).map(message),
          newer: newer.slice(0, 10).map(message),
          contextLimit: 10,
          hasOlder: older.length > 10,
          hasNewer: newer.length > 10,
        };
      });
    },
    sendMessage: async (actor, input, key) => {
      const d = parse(
        z.union([
          z.strictObject({
            agreementId: z.uuid(),
            body: z.string().trim().min(1).max(4000),
          }),
          z.strictObject({
            orderId: z.uuid(),
            body: z.string().trim().min(1).max(4000),
          }),
          z.strictObject({
            applicationId: z.uuid(),
            body: z.string().trim().min(1).max(4000),
          }),
        ]),
        input,
      );
      return store.as(actor, async (c) => {
        const authorize = async () => {
          await account(c, actor);
          await workSql(c, "SELECT campus.authorize_message_scope($1,$2)", [
            d.agreementId ? "agreement" : d.orderId ? "order" : "application",
            d.agreementId || d.orderId || d.applicationId,
          ]);
        };
        await authorize();
        const receipt = await idempotent(
          c,
          actor,
          "message.send",
          key,
          d,
          async () => {
            let result;
            try {
              result = d.applicationId
                ? (
                    await workSql(
                      c,
                      "INSERT INTO campus.messages(sender_id,application_id,body) VALUES($1,$2,$3) RETURNING *",
                      [actor, d.applicationId, d.body],
                    )
                  ).rows[0]
                : (
                    await workSql(
                      c,
                      "INSERT INTO campus.messages(sender_id,agreement_id,order_id,body) VALUES($1,$2,$3,$4) RETURNING id,sender_id,agreement_id,order_id,body,created_at",
                      [actor, d.agreementId || null, d.orderId || null, d.body],
                    )
                  ).rows[0];
            } catch (error) {
              if (
                error.code === "P0001" &&
                error.message === "application_conversation_closed"
              )
                throw new Problem(
                  409,
                  "application_conversation_closed",
                  "This application discussion is closed. No message was recorded for this request key.",
                );
              throw error;
            }
            await audit(c, actor, "message.send", result.id);
            return result;
          },
        );
        await authorize();
        return receipt;
      });
    },
    conversationParticipants: async (actor, input) => {
      const p = conversationQuery(input, true);
      return conversationRead(actor, async (c) => {
        await requireScope(c, p);
        return {
          scope: { type: p.type, id: p.scopeId },
          ...(await peoplePage(c, p, p.cursor, p.limit)),
        };
      });
    },
    conversation: async (actor, input) => {
      const p = conversationQuery(input);
      return conversationRead(actor, async (c) => {
        await requireScope(c, p);
        const column = scopeColumns[p.type];
        if (p.cursor)
          requireThat(
            (
              await c.query(
                `SELECT id FROM campus.messages WHERE ${column}=$1 AND id=$2 AND created_at=$3::timestamptz`,
                [p.scopeId, p.cursor.id, p.cursor.createdAt],
              )
            ).rows.length === 1,
            422,
            "invalid_input",
            "The message cursor is unavailable.",
          );
        const rows = (
          await c.query(
            `WITH people AS MATERIALIZED (SELECT * FROM campus.conversation_people($1,$2))
           SELECT m.id,m.body,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
           CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'displayName',p.display_name,'role',p.role) END AS author
           FROM campus.messages m LEFT JOIN people p ON p.id=m.sender_id
           WHERE m.${column}=$2 AND ($3::timestamptz IS NULL OR (m.created_at,m.id)<($3::timestamptz,$4::uuid))
           ORDER BY m.created_at DESC,m.id DESC LIMIT $5`,
            [
              p.type,
              p.scopeId,
              p.cursor?.createdAt ?? null,
              p.cursor?.id ?? null,
              p.limit + 1,
            ],
          )
        ).rows;
        const items = rows.slice(0, p.limit),
          last = items.at(-1),
          people = await peoplePage(c, p);
        return {
          scope: { type: p.type, id: p.scopeId },
          ...(p.type === "application"
            ? {
                applicationContext: found(
                  (
                    await c.query(
                      "SELECT campus.application_conversation_context($1) AS context",
                      [p.scopeId],
                    )
                  ).rows[0].context,
                ),
              }
            : {}),
          participants: people.items,
          participantCount: people.participantCount,
          participantLimit: people.limit,
          nextParticipantCursor: people.nextCursor,
          items,
          limit: p.limit,
          nextCursor:
            rows.length > p.limit
              ? encode({
                  type: p.type,
                  scopeId: p.scopeId,
                  kind: "messages",
                  id: last.id,
                  createdAt: last.createdAt,
                })
              : null,
        };
      });
    },
    messages: async (actor, input) => {
      const d = parse(scope, input);
      return privateRead(actor, async (c) => {
        await requireScope(c, d);
        return (
          await c.query(
            d.applicationId
              ? "SELECT * FROM campus.messages WHERE application_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100"
              : "SELECT id,sender_id,agreement_id,order_id,body,created_at FROM campus.messages WHERE agreement_id=$1 OR order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100",
            d.applicationId
              ? [d.applicationId]
              : [d.agreementId || null, d.orderId || null],
          )
        ).rows;
      });
    },
    saveTask: async (actor, id, input, key) => {
      uuid(id);
      parse(empty, input);
      return command(actor, "task.save:" + id, key, {}, async (c) => {
        found(
          (await c.query("SELECT id FROM campus.tasks WHERE id=$1", [id]))
            .rows[0],
        );
        await c.query(
          "INSERT INTO campus.saved VALUES($1,$2) ON CONFLICT DO NOTHING",
          [actor, id],
        );
        return { id, saved: true };
      });
    },
    unsaveTask: async (actor, id, input, key) => {
      uuid(id);
      parse(empty, input);
      return command(actor, "task.unsave:" + id, key, {}, async (c) => {
        await c.query(
          "DELETE FROM campus.saved WHERE user_id=$1 AND task_id=$2",
          [actor, id],
        );
        return { id, saved: false };
      });
    },
    savedTasks: (actor) =>
      read(
        actor,
        async (c) =>
          (
            await c.query(
              "SELECT t.*,to_char(t.due_date,'YYYY-MM-DD') AS due_date FROM campus.saved s JOIN campus.tasks t ON t.id=s.task_id WHERE s.user_id=$1 ORDER BY t.created_at DESC LIMIT 100",
              [actor],
            )
          ).rows,
      ),
  };
}
