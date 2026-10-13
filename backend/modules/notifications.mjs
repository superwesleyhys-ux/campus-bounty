import {
  z,
  parse,
  uuid,
  empty,
  found,
  requireThat,
  context,
} from "./common.mjs";
import { account, idempotent } from "../db/store.mjs";
import { workSql } from "./fulfillment.mjs";

// Versioned, fixed English copy never interpolates private business content.
const templatesV1 = {
  "application.received": [
    "New application",
    "A new application is ready to review.",
  ],
  "application.consent_requested": [
    "Application consent requested",
    "Review the proposed task before confirming your participation.",
  ],
  "application.consented": [
    "Application consent confirmed",
    "A proposed participant confirmed their consent.",
  ],
  "application.invited": [
    "Task invitation received",
    "The publisher invited your application to proceed.",
  ],
  "application.declined": [
    "Application declined",
    "The publisher declined this application.",
  ],
  "application.withdrawn": [
    "Application withdrawn",
    "The applicant withdrew this application or declined its invitation.",
  ],
  "application.superseded": [
    "Another application selected",
    "This application ended because another agreement was signed.",
  ],
  "application.accepted": [
    "Agreement signed",
    "The task invitation was accepted. Review the signed agreement.",
  ],
  "team.invite": [
    "Team invitation",
    "Review the team background before accepting or declining.",
  ],
  "team.accept": [
    "Team invitation accepted",
    "A participant accepted the team invitation.",
  ],
  "team.decline": [
    "Team invitation declined",
    "A participant declined the team invitation.",
  ],
  "team.revoke": [
    "Team invitation revoked",
    "A pending team invitation was revoked.",
  ],
  "team.leave": ["Team member left", "A participant left the team."],
  "team.remove": [
    "Team membership changed",
    "A participant was removed from the team.",
  ],
  "team.captain": [
    "Team captain changed",
    "Captaincy was transferred to another accepted member.",
  ],
  "team.context": [
    "Team background updated",
    "Review the current team background. Signed task terms are unchanged.",
  ],
  "milestone.submitted": [
    "Milestone work submitted",
    "A new version of milestone work is available.",
  ],
  "milestone.revision_requested": [
    "Milestone changes requested",
    "The publisher requested changes to submitted work.",
  ],
  "milestone.accepted": [
    "Milestone accepted",
    "The publisher accepted the submitted milestone.",
  ],
  "agreement.completed": [
    "Agreement completed",
    "All milestones in the agreement have been accepted.",
  ],
  "message.received": [
    "New message",
    "A participant sent a message in your conversation.",
  ],
  "order.created": [
    "New order",
    "An order was created and is awaiting payment.",
  ],
  "order.cancelled": [
    "Order cancelled",
    "The buyer cancelled the unpaid order.",
  ],
  "order.expired": [
    "Order reservation expired",
    "The unpaid order expired and its inventory reservation was released.",
  ],
  "order.shipped": ["Order dispatched", "The seller dispatched your order."],
  "order.ready_for_pickup": [
    "Order ready for pickup",
    "The seller marked your order ready for pickup.",
  ],
  "order.completed": [
    "Order receipt confirmed",
    "The buyer confirmed receipt of the order.",
  ],
  "eligibility.approved": [
    "Student eligibility approved",
    "Your student eligibility review was approved. View the outcome and validity period.",
  ],
  "eligibility.rejected": [
    "Student eligibility not approved",
    "Your student eligibility review was not approved. View the outcome for details.",
  ],
};
const timestamp = z.iso
  .datetime({ precision: 6 })
  .refine((v) => !v.startsWith("0000-"));
const cursorSchema = z.strictObject({
  createdAt: timestamp,
  id: z.uuid(),
  unread: z.boolean(),
});
export const notificationQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default("20"),
  unread: z.enum(["true", "false"]).default("false"),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export function notificationQuery(input) {
  const p = parse(notificationQuerySchema, input);
  let cursor = null;
  if (p.cursor) {
    let value;
    try {
      value = JSON.parse(Buffer.from(p.cursor, "base64url").toString("utf8"));
    } catch {
      /* parse below returns the normal 422 */
    }
    cursor = parse(cursorSchema, value);
    requireThat(
      cursor.unread === (p.unread === "true"),
      422,
      "invalid_input",
      "The cursor does not match the unread filter.",
    );
  }
  return { limit: Number(p.limit), unread: p.unread === "true", cursor };
}
const columns = `id,kind,template_version,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
 campus.notification_target(target_type,target_id) AS target,
 campus.notification_work_detail(id) AS work_context,
 CASE WHEN kind='message.received' AND target_type IN ('agreement','order','application') THEN (
   SELECT jsonb_build_object(
     'messageId',m.id,
     'createdAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
     'author',(SELECT jsonb_build_object('id',p.id,'displayName',p.display_name,'role',p.role)
       FROM campus.conversation_people(notifications.target_type,notifications.target_id) p WHERE p.id=m.sender_id),
     'preview',left(m.body,160),'truncated',char_length(m.body)>160)
   FROM campus.messages m
   WHERE notifications.event_key='message:'||m.id::text
     AND ((notifications.target_type='agreement' AND m.agreement_id=notifications.target_id)
       OR (notifications.target_type='order' AND m.order_id=notifications.target_id)
       OR (notifications.target_type='application' AND m.application_id=notifications.target_id))
 ) ELSE NULL END AS message_context`;
function present(row) {
  // Labels are resolved through current target permissions and never persisted.
  // Keep the typed navigation target unchanged for all clients.
  const { contextLabel = null, ...target } = row.target ?? {};
  const copy =
    row.target && row.template_version === 1 ? templatesV1[row.kind] : null;
  return {
    id: row.id,
    kind: row.kind,
    templateVersion: row.template_version,
    title: copy?.[0] ?? "Activity update",
    description:
      copy?.[1] ?? "This activity is no longer available to your account.",
    createdAt: row.created_at,
    readAt: row.read_at,
    contextLabel: row.target ? contextLabel : null,
    target: row.target ? target : null,
    targetAvailable: row.target !== null,
    // Missing legacy context is unavailable; never infer a current version.
    workContext: row.target ? (row.work_context ?? null) : null,
    // Exact event + target + current message/participant visibility, never a snapshot.
    messageContext:
      row.target && row.kind === "message.received"
        ? (row.message_context ?? null)
        : null,
    navigationAnchor:
      row.target && row.work_context
        ? {
            type: "milestone",
            milestoneId: row.work_context.milestoneId,
            submissionId: row.work_context.submissionId,
            reviewId: row.work_context.reviewId,
          }
        : null,
  };
}
export function notificationModule(store) {
  const { privateRead } = context(store);
  return {
    notifications: async (actor, input = {}) => {
      const p = notificationQuery(input);
      return privateRead(actor, async (c) => {
        const rows = (
          await c.query(
            `SELECT ${columns} FROM campus.notifications
          WHERE recipient_id=$1 AND (NOT $2::boolean OR read_at IS NULL)
          AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
          ORDER BY campus.notifications.created_at DESC,id DESC LIMIT $5`,
            [
              actor,
              p.unread,
              p.cursor?.createdAt ?? null,
              p.cursor?.id ?? null,
              p.limit + 1,
            ],
          )
        ).rows;
        const items = rows.slice(0, p.limit).map(present);
        const last = items.at(-1);
        const nextCursor =
          rows.length > p.limit
            ? Buffer.from(
                JSON.stringify({
                  createdAt: last.createdAt,
                  id: last.id,
                  unread: p.unread,
                }),
              ).toString("base64url")
            : null;
        const { count } = (
          await c.query(
            "SELECT count(*)::int AS count FROM campus.notifications WHERE recipient_id=$1 AND read_at IS NULL",
            [actor],
          )
        ).rows[0];
        return { items, nextCursor, unreadCount: count, limit: p.limit };
      });
    },
    readNotification: async (actor, id, input, key) => {
      uuid(id);
      const data = parse(empty, input);
      return store.as(actor, async (c) => {
        // Hold account state through replay/key waits. Restricted and expired users
        // retain private-history access; acknowledgement is not a business write.
        await c.query("SELECT id FROM campus.users WHERE id=$1 FOR SHARE", [
          actor,
        ]);
        await account(c, actor);
        found(
          (
            await c.query(
              "SELECT id FROM campus.notifications WHERE id=$1 AND recipient_id=$2",
              [id, actor],
            )
          ).rows[0],
        );
        await idempotent(
          c,
          actor,
          `notification.read:${id}`,
          key,
          data,
          async () => {
            await workSql(c, "SELECT campus.mark_notification_read($1)", [id]);
            return { id };
          },
        );
        return present(
          found(
            (
              await c.query(
                `SELECT ${columns} FROM campus.notifications WHERE id=$1 AND recipient_id=$2`,
                [id, actor],
              )
            ).rows[0],
          ),
        );
      });
    },
  };
}
