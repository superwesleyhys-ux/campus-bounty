import { readdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { taskSchema } from "../backend/modules/tasks.mjs";
import {
  submissionSchema,
  reviewSchema,
  revisionRequestSchema,
} from "../backend/modules/fulfillment.mjs";
import { notificationQuerySchema } from "../backend/modules/notifications.mjs";
import { productSchema } from "../backend/modules/goods.mjs";
import {
  profileSchema,
  eligibilityRequestSchema,
  eligibilityDecisionSchema,
} from "../backend/modules/account.mjs";
import {
  teamRevisionSchema,
  teamTargetSchema,
  createTeamSchema,
  teamContextUpdateSchema,
} from "../backend/modules/teams.mjs";
const str = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  positive = { type: "integer", minimum: 1 },
  object = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }),
  empty = object({});
const teamState = {
  enum: ["invited", "accepted", "declined", "revoked", "left", "removed"],
};
const teamFields = {
  id: uuid,
  name: str,
  owner_id: { anyOf: [uuid, { type: "null" }] },
  revision: positive,
  status: { enum: ["active", "archived"] },
  archived_at: {
    anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
  },
  own_state: teamState,
  can_view_roster: { type: "boolean" },
};
const address = object(
  {
    name: str,
    line1: str,
    line2: str,
    city: str,
    region: str,
    postalCode: str,
    country: { const: "US" },
  },
  ["name", "line1", "city", "region", "postalCode", "country"],
);
const bodies = {
  "/notifications/{id}/read": empty,
  "/me": z.toJSONSchema(profileSchema),
  "/me/eligibility-requests": z.toJSONSchema(eligibilityRequestSchema),
  "/admin/eligibility-requests/{id}/decision": z.toJSONSchema(
    eligibilityDecisionSchema,
  ),
  "/auth/challenges": object({ email: { type: "string", format: "email" } }),
  "/auth/sessions": object({
    challengeId: uuid,
    code: { type: "string", pattern: "^\\d{6}$" },
    displayName: str,
  }),
  "/auth/session": empty,
  "/teams": z.toJSONSchema(createTeamSchema),
  "/teams/{id}/context": z.toJSONSchema(teamContextUpdateSchema),
  "/teams/{id}/invitations": z.toJSONSchema(teamTargetSchema),
  "/teams/{id}/membership": z.toJSONSchema(teamRevisionSchema),
  "/teams/{id}/membership/decline": z.toJSONSchema(teamRevisionSchema),
  "/teams/{id}/membership/leave": z.toJSONSchema(teamRevisionSchema),
  "/teams/{id}/members/{userId}/revoke": z.toJSONSchema(teamRevisionSchema),
  "/teams/{id}/members/{userId}/remove": z.toJSONSchema(teamRevisionSchema),
  "/teams/{id}/captain": z.toJSONSchema(teamTargetSchema),
  "/teams/{id}/archive": z.toJSONSchema(teamRevisionSchema),
  "/tasks": z.toJSONSchema(taskSchema),
  "/tasks/{id}/applications": object(
    { proposal: str, teamId: { anyOf: [uuid, { type: "null" }] } },
    ["proposal"],
  ),
  "/applications/{id}/consent": empty,
  "/applications/{id}/invitation": empty,
  "/applications/{id}/acceptance": empty,
  "/applications/{id}/withdrawal": empty,
  "/applications/{id}/rejection": empty,
  "/milestones/{id}/submissions": z.toJSONSchema(submissionSchema),
  "/milestones/{id}/acceptance": z.toJSONSchema(reviewSchema),
  "/milestones/{id}/revision-requests": z.toJSONSchema(revisionRequestSchema),
  "/agreements/{id}/completion": empty,
  "/products": z.toJSONSchema(productSchema),
  "/products/{id}/quotes": object({
    quantity: { type: "integer", minimum: 1, maximum: 100 },
    deliveryMethod: { enum: ["pickup", "shipping"] },
  }),
  "/orders": object({ quoteId: uuid, shippingAddress: address }, ["quoteId"]),
  "/orders/{id}/fulfillment": object({ carrier: str, trackingNumber: str }, []),
  "/orders/{id}/receipt": empty,
  "/orders/{id}/cancellation": empty,
  "/messages": {
    oneOf: [
      object({ agreementId: uuid, body: str }),
      object({ orderId: uuid, body: str }),
      object({ applicationId: uuid, body: str }),
    ],
  },
  "/saved/tasks/{id}": empty,
};
const root = new URL("../src/app/api/v1/", import.meta.url);
const paths = {};
async function walk(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      await walk(new URL(entry.name + "/", dir), prefix + "/" + entry.name);
    else if (entry.name === "route.js") {
      const source = await readFile(new URL(entry.name, dir), "utf8"),
        path = prefix.replace(/\[([^\]]+)\]/g, "{$1}");
      paths[path] = {};
      for (const m of source.matchAll(
        /export const (GET|POST|PATCH|DELETE)\s*=/g,
      )) {
        const verb = m[1],
          isPublic = [
            "/health",
            "/institutions",
            "/auth/challenges",
            "/auth/sessions",
          ].includes(path),
          write = verb !== "GET";
        const section =
          source.slice(m.index).split(/export const/)[1] ||
          source.slice(m.index);
        const status = /status:\s*201/.test(section)
          ? "201"
          : path === "/auth/challenges"
            ? "202"
            : "200";
        const parameters = [];
        for (const match of path.matchAll(/\{([^}]+)\}/g))
          parameters.push({
            name: match[1],
            in: "path",
            required: true,
            schema: uuid,
          });
        if (write) {
          parameters.push({
            name: "Origin",
            in: "header",
            required: true,
            schema: { type: "string", format: "uri" },
          });
          if (!path.startsWith("/auth/"))
            parameters.push({
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", minLength: 8, maxLength: 128 },
            });
        }
        if (verb === "GET" && ["/tasks", "/products"].includes(path))
          parameters.push(
            {
              name: "q",
              in: "query",
              schema: { type: "string", maxLength: 120 },
            },
            {
              name: "sort",
              in: "query",
              schema: {
                enum: ["recent", "amount_asc", "amount_desc"],
                default: "recent",
              },
            },
            {
              name: "scope",
              in: "query",
              schema: { enum: ["all", "mine"], default: "all" },
            },
            ...["limit", "offset"].map((name) => ({
              name,
              in: "query",
              schema: {
                type: "integer",
                minimum: name === "limit" ? 1 : 0,
                maximum: name === "limit" ? 100 : 10000,
              },
            })),
          );
        if (verb === "GET" && path === "/tasks")
          parameters.push({
            name: "category",
            in: "query",
            schema: {
              enum: [
                "Research",
                "Design",
                "Engineering",
                "Writing",
                "Campus",
                "Other",
              ],
            },
          });
        if (verb === "GET" && path === "/teams/{id}/candidates")
          parameters.push({
            name: "userId",
            in: "query",
            required: true,
            description:
              "Exact member code shared by a teammate. Captain only; no email is returned.",
            schema: uuid,
          });
        if (
          verb === "GET" &&
          ["/me/eligibility-requests", "/admin/eligibility-requests"].includes(
            path,
          )
        ) {
          parameters.push(
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 20,
              },
            },
            {
              name: "cursor",
              in: "query",
              description: "Opaque nextCursor returned by the previous page.",
              schema: { type: "string", maxLength: 300 },
            },
          );
          if (path.startsWith("/admin/"))
            parameters.push({
              name: "status",
              in: "query",
              schema: {
                enum: ["pending", "approved", "rejected", "all"],
                default: "pending",
              },
            });
        }
        if (verb === "GET" && path === "/notifications")
          parameters.push(
            ...Object.entries(
              z.toJSONSchema(notificationQuerySchema).properties,
            ).map(([name, schema]) => ({
              name,
              in: "query",
              schema,
              ...(name === "cursor"
                ? {
                    description:
                      "Opaque nextCursor bound to the unread filter; retains exact database timestamp precision. Refresh page one to see newer arrivals.",
                  }
                : {}),
            })),
          );
        if (verb === "GET" && path === "/messages")
          parameters.push(
            ...["agreementId", "orderId", "applicationId"].map((name) => ({
              name,
              in: "query",
              description: "Specify exactly one conversation scope.",
              schema: uuid,
            })),
          );
        if (
          verb === "GET" &&
          [
            "/conversations",
            "/conversations/participants",
            "/conversations/search",
          ].includes(path)
        )
          parameters.push(
            ...["agreementId", "orderId", "applicationId"].map((name) => ({
              name,
              in: "query",
              description:
                "Exactly one scope is required; duplicate and unknown keys are rejected.",
              schema: uuid,
            })),
            {
              name: "limit",
              in: "query",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: path.endsWith("/participants") ? 100 : 50,
                default: path.endsWith("/participants")
                  ? 100
                  : path.endsWith("/search")
                    ? 20
                    : 30,
              },
            },
            {
              name: "cursor",
              in: "query",
              description:
                "Opaque scope- and kind-bound cursor; use unchanged. Message timestamps retain database microseconds. Participant and message cursors are not interchangeable.",
              schema: { type: "string", maxLength: 512 },
            },
          );
        if (verb === "GET" && path === "/conversations/search")
          parameters.push({
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 160 },
            description:
              "Trimmed nonempty 1–160 Unicode code points, no NUL. Literal case-insensitive body substring; percent, underscore and backslash are literal. Cursor binds the normalized query as well as scope and kind.",
          });
        if (verb === "GET" && path === "/conversations/message")
          parameters.push(
            ...["agreementId", "orderId", "applicationId"].map((name) => ({
              name,
              in: "query",
              schema: uuid,
              description:
                "Exactly one scope is required; duplicate and unknown keys rejected.",
            })),
            {
              name: "messageId",
              in: "query",
              required: true,
              schema: uuid,
              description: "Exact message UUID in this authorized scope.",
            },
          );
        paths[path][verb.toLowerCase()] = {
          operationId: verb.toLowerCase() + path.replaceAll(/[^a-zA-Z]/g, "_"),
          summary: verb + " " + path,
          ...(path.startsWith("/admin/eligibility-requests")
            ? {
                description:
                  "Restricted to trusted institution-scoped reviewers, excluding self review. Disabled in production until administrator multi-factor verification and sensitive-action step-up are implemented. Approval expiry must be in the future, at most 365 days, and no later than the applicant's campus verification expiry.",
              }
            : {}),
          ...(path.startsWith("/teams") && path !== "/teams/{id}/candidates"
            ? {
                description:
                  "Current invited or accepted members can view the roster and current context (including an archived captain); terminal members receive only their own member row, owner_id null, and context null. Team summaries omit context. Legacy creation without context returns four blank strings; supplied creation context and context updates require all four string fields, with the first three nonempty. Context is invitation background, not a commitment amendment. Only the current non-locked captain of an active team may replace it, even after eligibility expires. An actual context change advances the team revision and records immutable history; identical values are a no-op. New invitations and re-invitations require purpose, activities and timeCommitment, otherwise 409 team_context_required. Existing legacy pending invitations may still be accepted. Mutations return the fresh Team, including idempotent retries. Lifecycle and context commands require expectedRevision; stale revisions return 409 team_revision_changed. Creation, invitation and acceptance require current student eligibility; exit and captain-management actions allow non-locked expired or restricted accounts. Archiving requires no other accepted members or pending invitations. Existing application and agreement snapshots remain unchanged.",
              }
            : {}),
          ...(path.startsWith("/milestones/") ||
          path === "/agreements/{id}/completion"
            ? {
                description:
                  "Agreement participants retain access independently of current team membership. New fulfillment commands require an active account and current campus verification; they do not require current student application eligibility. Submission versions are immutable; milestone revision advances with each new submission or review. Review commands bind the exact submissionId, expectedVersion and expectedRevision; outdated tuples return 409 stale_revision. Only the publisher can request changes or accept. Feedback is tied to the reviewed submission and does not amend agreement terms. Commands return current resource state plus the original operation receipt on idempotent retry. Accepting the final outstanding milestone completes fulfillment. The explicit completion command supports active historical agreements whose nonempty milestone set is already entirely accepted. Completion never initiates payment, settlement or a fund transfer. History reads are available to non-locked agreement participants even after eligibility expires; locked accounts cannot read it.",
              }
            : {}),
          ...(path.startsWith("/conversations")
            ? {
                description:
                  "Authorized private conversation pages. Agreement participants are the publisher and frozen signers; orders contain buyer and seller. Application discussion includes publisher, applicant and frozen application members including unconfirmed proposed participants; later team joiners are excluded. GET /conversations adds applicationContext only for application scope. New sends require applied/invited plus open task, active account and current campus membership; consent/student eligibility are not messaging requirements. Accepted application context links only its exact authorized agreement; messages stay in their original scope. Current editable display names are not verified identity. Expired/restricted accounts retain history, locked accounts are denied; unknown/unauthorized scope is 404. Exactly one scope, strict query keys and cursor validation. Messages use descending exact timestamp and UUID; participant UUIDs ascend independently. Initial roster is bounded100 with full continuation. GET has no side effects. Refresh the first page for new messages; preserve the oldest cursor for older history.",
              }
            : {}),
          ...(path === "/conversations/search"
            ? {
                description:
                  "Read-only literal substring search across all currently authorized messages in one agreement/order/application, independent of loaded history. Exactly one scope and trimmed q (1–160 Unicode code points, no NUL); limit default20/max50. Strict keys, duplicates and cursor validation. After scope/account authorization, PostgreSQL folds the original trimmed q once; that exact folded value binds the cursor fingerprint and parameter in strpos(lower(body), foldedQuery). Both operands use the same database case rules, including Unicode; no JavaScript query casing. No regex/wildcards or Unicode normalization. Full matching bodies/current authorized authors (null if absent), newest exact microsecond timestamp then UUID descending; no total. Cursor binds normalized query/scope/kind. Expired/restricted reads allowed; locked denied, foreign scope404. No acknowledgements. Scoped scans are not a production-scale search guarantee.",
              }
            : {}),
          ...(path === "/conversations/message"
            ? {
                description:
                  "Exact authorized message plus nearest at most10 older and10 newer messages in the same scope. Each side is chronological ascending by exact microsecond timestamp then UUID and excludes selected. hasOlder/hasNewer indicate more beyond the returned window. One query snapshot, at most21 messages. Full bodies/current authors (null if absent). Cross-scope or unknown IDs404. Strict scope/messageId only. Restricted/expired reads retained, locked denied. Isolated selection does not change ordinary pagination or acknowledge a read.",
              }
            : {}),
          ...(path === "/messages"
            ? {
                description:
                  "Compatibility endpoint. GET returns the original latest100 raw message array. POST trims body to1–4000 characters, checks current scope/account/campus permission before replay and after key waits, and returns one original message for an exact-key retry. Changed normalized body conflicts. Lost permission cannot replay cached content. An identical committed application receipt can replay after application/task closure under current account/membership/scope gates. Closure is checked only on first INSERT: 409 application_conversation_closed definitively means no message or receipt was recorded for that key; do not treat it as an unknown delivery. Changed body with an existing key remains 409 idempotency_conflict. Agreement/order raw response fields stay unchanged; application raw rows also include application_id. No realtime push.",
              }
            : {}),
          ...(path.startsWith("/notifications")
            ? {
                description:
                  "Recipient-scoped durable in-app activity. GET never marks read. Unknown or duplicate query keys are rejected. Read acknowledgement is explicit and idempotent; permissions are checked before replay. Expired/restricted users retain permitted private history, locked accounts are denied. Targets are reauthorized for every response and unavailable targets are redacted. Read status is not business completion. New milestone events include exact immutable submission/review anchors and event version under current target authorization. Legacy milestone context remains null without inference or backfill. Additive nullable messageContext only for message.received: exact existing message event key plus exact target scope and current message/participant authorization, full message ID/time/current author (nullable), plain-text preview up to160 Unicode code points and truncated flag. Exact legacy message keys may resolve; malformed/unavailable mapping stays null. Private bodies and author-name snapshots are not persisted in notifications; raw event keys are never exposed. The DTO contains only authorized preview/current-author data. No proposal, feedback, address, external email/push or historical notification backfill.",
              }
            : {}),
          ...(path === "/applications/{id}" && verb === "GET"
            ? {
                description:
                  "Current-authorized private single application history, independent of the latest-100 list. Publisher, applicant and frozen application members retain RLS-permitted access after campus verification expires; locked accounts denied. Task is null when campus catalog access is unavailable, without exposing its id or title. Unknown or unauthorized ids return 404; invalid UUID returns 422. GET has no side effects.",
              }
            : {}),
          security: isPublic ? [] : [{ campusSession: [] }],
          parameters,
          ...(write
            ? {
                requestBody: {
                  required: true,
                  content: {
                    "application/json": { schema: bodies[path] || empty },
                  },
                },
              }
            : {}),
          responses: {
            [status]: {
              description:
                "Successful resource response. Field names and shapes follow the endpoint response schema. No-store.",
              content: {
                "application/json": {
                  schema:
                    path === "/conversations/search" && verb === "GET"
                      ? { $ref: "#/components/schemas/ConversationSearchPage" }
                      : path === "/conversations/message" && verb === "GET"
                        ? {
                            $ref: "#/components/schemas/ConversationMessageWindow",
                          }
                        : path === "/conversations" && verb === "GET"
                          ? { $ref: "#/components/schemas/ConversationPage" }
                          : path === "/conversations/participants" &&
                              verb === "GET"
                            ? {
                                $ref: "#/components/schemas/ConversationParticipantsPage",
                              }
                            : path === "/applications/{id}" && verb === "GET"
                              ? {
                                  $ref: "#/components/schemas/ApplicationHistory",
                                }
                              : path === "/notifications" && verb === "GET"
                                ? {
                                    $ref: "#/components/schemas/NotificationPage",
                                  }
                                : path === "/notifications/{id}/read" &&
                                    verb === "POST"
                                  ? {
                                      $ref: "#/components/schemas/Notification",
                                    }
                                  : path === "/agreements" && verb === "GET"
                                    ? {
                                        type: "array",
                                        items: {
                                          $ref: "#/components/schemas/AgreementOverview",
                                        },
                                      }
                                    : path === "/tasks/{id}" && verb === "GET"
                                      ? {
                                          type: "object",
                                          properties: {
                                            related_agreement: {
                                              anyOf: [
                                                object({
                                                  id: uuid,
                                                  state: str,
                                                }),
                                                { type: "null" },
                                              ],
                                              description:
                                                "Current user's RLS-visible agreement only; null for outsiders. Task status is recruitment state, not fulfillment state.",
                                            },
                                          },
                                          required: ["related_agreement"],
                                        }
                                      : verb === "POST" &&
                                          (path.startsWith("/milestones/") ||
                                            path ===
                                              "/agreements/{id}/completion")
                                        ? {
                                            $ref: "#/components/schemas/FulfillmentResult",
                                          }
                                        : path === "/milestones/{id}/reviews" &&
                                            verb === "GET"
                                          ? {
                                              type: "array",
                                              items: {
                                                $ref: "#/components/schemas/MilestoneReview",
                                              },
                                            }
                                          : path === "/teams/{id}/candidates"
                                            ? object({
                                                user_id: uuid,
                                                display_name: str,
                                              })
                                            : path === "/teams" &&
                                                verb === "GET"
                                              ? {
                                                  type: "array",
                                                  items: {
                                                    $ref: "#/components/schemas/TeamSummary",
                                                  },
                                                }
                                              : path.startsWith("/teams")
                                                ? {
                                                    $ref: "#/components/schemas/Team",
                                                  }
                                                : {},
                },
              },
            },
            ...Object.fromEntries(
              [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503].map(
                (n) => [
                  n,
                  {
                    description:
                      path === "/auth/challenges" && n === 422
                        ? "Malformed email or unsupported university domain. unsupported_university_email means the exact domain is not enabled for an active approved university; no challenge or mail is created."
                        : "Problem response",
                    content: {
                      "application/problem+json": {
                        schema: { $ref: "#/components/schemas/Problem" },
                      },
                    },
                  },
                ],
              ),
            ),
          },
        };
      }
    }
  }
}
await walk(root);
const spec = {
  openapi: "3.1.0",
  info: {
    title: "Campus Bounty Shared Backend",
    version: "0.8.0",
    description:
      "Isolated backend milestone. No payment initiation or settlement endpoint is enabled. Agreements await funding; orders reserve inventory pending payment. Team application members must consent before invitation. Session cookies are campus_session on localhost and __Host-campus_session over production HTTPS.",
  },
  servers: [{ url: "/api/v1" }],
  paths,
  components: {
    securitySchemes: {
      campusSession: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-campus_session",
      },
    },
    schemas: {
      ConversationScope: object({
        type: { enum: ["agreement", "order", "application"] },
        id: uuid,
      }),
      ConversationParticipant: object({
        id: uuid,
        displayName: str,
        role: {
          enum: [
            "publisher",
            "captain",
            "participant",
            "buyer",
            "seller",
            "applicant",
            "proposed_participant",
          ],
        },
      }),
      ConversationMessage: object({
        id: uuid,
        body: str,
        createdAt: {
          type: "string",
          format: "date-time",
          description:
            "UTC with exactly six fractional digits; do not round for ordering.",
        },
        author: {
          anyOf: [
            { $ref: "#/components/schemas/ConversationParticipant" },
            { type: "null" },
          ],
        },
      }),
      ApplicationConversationContext: object({
        applicationId: uuid,
        applicationState: {
          enum: [
            "applied",
            "invited",
            "withdrawn",
            "declined",
            "superseded",
            "accepted",
          ],
        },
        taskStatus: { enum: ["open", "contracted", "closed"] },
        canSend: { type: "boolean" },
        sendUnavailableReason: {
          enum: [
            null,
            "account_restricted",
            "membership_required",
            "application_closed",
            "task_closed",
          ],
        },
        agreementId: {
          anyOf: [uuid, { type: "null" }],
          description:
            "The exact currently authorized agreement for this application, otherwise null.",
        },
      }),
      ConversationPage: {
        ...object(
          {
            applicationContext: {
              $ref: "#/components/schemas/ApplicationConversationContext",
              description:
                "Present only for application scope; required for that scope. Current read-time availability, never authority for a later send.",
            },
            scope: { $ref: "#/components/schemas/ConversationScope" },
            participants: {
              type: "array",
              maxItems: 100,
              items: { $ref: "#/components/schemas/ConversationParticipant" },
            },
            participantCount: { type: "integer", minimum: 0 },
            participantLimit: { const: 100 },
            nextParticipantCursor: { anyOf: [str, { type: "null" }] },
            items: {
              type: "array",
              maxItems: 50,
              items: { $ref: "#/components/schemas/ConversationMessage" },
            },
            nextCursor: { anyOf: [str, { type: "null" }] },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          [
            "scope",
            "participants",
            "participantCount",
            "participantLimit",
            "nextParticipantCursor",
            "items",
            "nextCursor",
            "limit",
          ],
        ),
        if: {
          properties: {
            scope: { properties: { type: { const: "application" } } },
          },
        },
        then: { required: ["applicationContext"] },
        else: { not: { required: ["applicationContext"] } },
      },
      ConversationParticipantsPage: object({
        scope: { $ref: "#/components/schemas/ConversationScope" },
        items: {
          type: "array",
          maxItems: 100,
          items: { $ref: "#/components/schemas/ConversationParticipant" },
        },
        participantCount: { type: "integer", minimum: 0 },
        nextCursor: { anyOf: [str, { type: "null" }] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }),
      ConversationSearchPage: object({
        scope: { $ref: "#/components/schemas/ConversationScope" },
        q: { type: "string", minLength: 1, maxLength: 160 },
        items: {
          type: "array",
          maxItems: 50,
          items: { $ref: "#/components/schemas/ConversationMessage" },
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        nextCursor: { anyOf: [str, { type: "null" }] },
      }),
      ConversationMessageWindow: object({
        scope: { $ref: "#/components/schemas/ConversationScope" },
        message: { $ref: "#/components/schemas/ConversationMessage" },
        older: {
          type: "array",
          maxItems: 10,
          items: { $ref: "#/components/schemas/ConversationMessage" },
          description:
            "Nearest older messages, chronological ascending; excludes selected.",
        },
        newer: {
          type: "array",
          maxItems: 10,
          items: { $ref: "#/components/schemas/ConversationMessage" },
          description:
            "Nearest newer messages, chronological ascending; excludes selected.",
        },
        contextLimit: { const: 10 },
        hasOlder: {
          type: "boolean",
          description: "More exist before returned older window.",
        },
        hasNewer: {
          type: "boolean",
          description: "More exist after returned newer window.",
        },
      }),
      NotificationMessageContext: object({
        messageId: uuid,
        createdAt: {
          type: "string",
          format: "date-time",
          description: "Message time with six fractional digits in UTC.",
        },
        author: {
          anyOf: [
            { $ref: "#/components/schemas/ConversationParticipant" },
            { type: "null" },
          ],
        },
        preview: {
          type: "string",
          maxLength: 160,
          description:
            "Plain text; at most160 Unicode code points, no added ellipsis.",
        },
        truncated: { type: "boolean" },
      }),
      NotificationWorkContext: object({
        type: { const: "milestone" },
        milestoneId: uuid,
        milestoneTitle: str,
        milestonePosition: positive,
        submissionId: uuid,
        submissionVersion: positive,
        milestoneRevision: positive,
        reviewId: { anyOf: [uuid, { type: "null" }] },
      }),
      NotificationNavigationAnchor: object({
        type: { const: "milestone" },
        milestoneId: uuid,
        submissionId: uuid,
        reviewId: { anyOf: [uuid, { type: "null" }] },
      }),
      ApplicationHistory: object({
        id: uuid,
        state: {
          enum: [
            "applied",
            "invited",
            "accepted",
            "withdrawn",
            "declined",
            "superseded",
          ],
        },
        proposal: str,
        created_at: { type: "string", format: "date-time" },
        task: { anyOf: [object({ id: uuid, title: str }), { type: "null" }] },
        members: {
          type: "array",
          items: object({
            user_id: uuid,
            display_name: str,
            confirmed: { type: "boolean" },
          }),
        },
      }),
      Notification: object({
        id: uuid,
        kind: str,
        templateVersion: { const: 1 },
        title: str,
        description: str,
        createdAt: { type: "string", format: "date-time" },
        readAt: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
        target: {
          anyOf: [
            object(
              {
                type: {
                  enum: [
                    "application",
                    "agreement",
                    "order",
                    "team",
                    "eligibility",
                  ],
                },
                id: uuid,
                taskId: uuid,
              },
              ["type", "id"],
            ),
            { type: "null" },
          ],
        },
        messageContext: {
          anyOf: [
            { $ref: "#/components/schemas/NotificationMessageContext" },
            { type: "null" },
          ],
          description:
            "Only exact message.received event/target mapping under current access; other or unavailable mapping null. Author may independently be null. No stored body/name snapshots or exposed event key.",
        },
        workContext: {
          anyOf: [
            { $ref: "#/components/schemas/NotificationWorkContext" },
            { type: "null" },
          ],
          description:
            "Exact new milestone event context, authorized now; null for legacy/unavailable/other events. Never infer historical versions.",
        },
        navigationAnchor: {
          anyOf: [
            { $ref: "#/components/schemas/NotificationNavigationAnchor" },
            { type: "null" },
          ],
        },
        targetAvailable: { type: "boolean" },
        contextLabel: {
          anyOf: [str, { type: "null" }],
          description:
            "Current authorized project/team/order context, derived at response time; null after access is lost. No message or feedback body.",
        },
      }),
      NotificationPage: object({
        items: {
          type: "array",
          items: { $ref: "#/components/schemas/Notification" },
        },
        nextCursor: { anyOf: [str, { type: "null" }] },
        unreadCount: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      }),
      AgreementOverview: {
        type: "object",
        required: ["id", "milestone_counts"],
        properties: {
          id: uuid,
          milestone_counts: object(
            Object.fromEntries(
              [
                "pending",
                "submitted",
                "revision_requested",
                "accepted",
                "total",
              ].map((name) => [name, { type: "integer", minimum: 0 }]),
            ),
          ),
        },
      },
      MilestoneReview: object({
        id: uuid,
        milestone_id: uuid,
        submission_id: uuid,
        submission_version: positive,
        milestone_revision: positive,
        reviewer_id: uuid,
        decision: { enum: ["revision_requested", "accepted"] },
        feedback: str,
        created_at: { type: "string", format: "date-time" },
      }),
      FulfillmentResult: {
        type: "object",
        required: ["agreement", "receipt"],
        properties: {
          milestone: {
            type: "object",
            description:
              "Current milestone row, including revision, version, latest_submission_id and accepted_submission_id.",
          },
          submission: {
            anyOf: [{ type: "object" }, { type: "null" }],
            description:
              "Current latest submission. It may differ from receipt.submissionId on a replay after a later operation.",
          },
          agreement: object({ id: uuid, state: str }),
          receipt: object(
            {
              operation: {
                enum: ["submit", "revision_requested", "accepted", "completed"],
              },
              submissionId: uuid,
              reviewId: uuid,
              agreementId: uuid,
            },
            ["operation"],
          ),
        },
      },
      TeamSummary: object(teamFields),
      Team: object({
        ...teamFields,
        context: {
          anyOf: [
            { $ref: "#/components/schemas/TeamContext" },
            { type: "null" },
          ],
        },
        members: {
          type: "array",
          items: object({
            user_id: uuid,
            display_name: str,
            state: teamState,
            can_captain: { type: "boolean" },
          }),
        },
      }),
      TeamContext: object({
        purpose: { type: "string", maxLength: 1000 },
        activities: { type: "string", maxLength: 1500 },
        timeCommitment: { type: "string", maxLength: 500 },
        projectContext: { type: "string", maxLength: 1500 },
      }),
      Problem: object({
        type: str,
        title: str,
        status: { type: "integer" },
        code: str,
        detail: str,
        requestId: uuid,
      }),
    },
  },
};
await writeFile(
  new URL("../docs/backend-openapi.json", import.meta.url),
  JSON.stringify(spec, null, 2) + "\n",
);
console.log(`Documented ${Object.keys(paths).length} resource paths.`);
