# Round 10 application discussion backend contract

Task 1 frozen implementation contract. Authoritative source: `014_application_conversations.sql`, conversation/notification modules, generated OpenAPI. Migration 001–013 bytes are unchanged. Apply 014 only through the separately reviewed Task 2 upgrade. Task 1 used disposable local databases; it did not migrate the current preview.

## Scope and permissions

Every request selects exactly one of `agreementId`, `orderId`, `applicationId` (UUID). Unknown keys, repeated HTTP query keys, missing scope, two/three scopes, malformed UUIDs, invalid limits or cursors are `422 invalid_input`. No private room before an application exists; no arbitrary user-to-user messaging.

Application scope is the application UUID, never task/team/agreement UUID. Readers are the task publisher, applicant and frozen `application_members`, including `confirmed=false`. Later team joiners and different applicants are excluded; former team members retain their frozen application history. Messaging never changes consent, eligibility, task terms or agreement state.

Non-locked authorized participants retain private history when restricted or campus verification expires. Locked accounts get `403 account_locked` from private endpoints. Unknown/foreign application/message is `404 not_found`. No name lookup by arbitrary user UUID: authorized participants have current editable names, not historical identity snapshots.

New sends need an active account, current valid affiliation with enabled domain/active institution, application state `applied` or `invited`, and task status `open`. Student eligibility and member consent are not send conditions. `withdrawn`, `declined`, `superseded`, `accepted`, or non-open task closes new sends. Reapplication has a fresh UUID and empty message history. An accepted application's messages stay in that scope; no copies/backfill into the agreement.

## Endpoint matrix

All responses use existing no-store/authentication/origin/problem conventions. Paths below are under `/api/v1`.

| Endpoint | Application input | Result and bounds |
|---|---|---|
| GET `/conversations` | `applicationId`, optional `limit`, `cursor` | Existing conversation page plus required `applicationContext` below. History default 30/max 50; descending exact microseconds + UUID. Initial participants max 100 with independent continuation. |
| GET `/conversations/participants` | `applicationId`, optional `limit`, `cursor` | Existing participants page; default/max 100, ascending UUID. |
| GET `/conversations/search` | `applicationId`, `q`, optional `limit`, `cursor` | Existing search page; default 20/max 50. Trimmed literal substring, 1–160 Unicode code points, no NUL. PostgreSQL folds both operands; punctuation has no wildcard/regex meaning. Full currently authorized body and author. |
| GET `/conversations/message` | `applicationId`, `messageId` | Exact authorized message, nearest up to 10 older and 10 newer; chronological neighbors, no duplicate selection, availability flags, one statement snapshot. |
| GET `/messages` | `applicationId` only | Legacy latest-100 array; application rows include `application_id`. Agreement/order arrays preserve their existing six raw fields. Repeated queries are rejected. |
| POST `/messages` | `{ "applicationId": "uuid", "body": "text" }` plus `Idempotency-Key` | 201 original raw receipt; body trims to 1–4000 characters, existing key rules unchanged. Application receipt fields: `id`, `sender_id`, `agreement_id:null`, `order_id:null`, `body`, `created_at`, `application_id`. Existing agreement/order receipts keep their six original fields. |
| GET `/notifications` and POST `/notifications/{id}/read` | Existing recipient-scoped APIs | Application message notifications resolve exact event/scope/message into existing `messageContext`; read acknowledgement remains explicit. |

History/search/participants cursor schemas include `type:"application"`, canonical lowercase `scopeId`, kind, and existing timestamp/UUID/query hash fields. Cursors are canonical base64url JSON, bound to exact scope and kind; cross-type, cross-scope, altered/nonexistent row and mismatched folded query are refused. Search and exact context do not depend on the currently loaded history page. Read endpoints do not send, notify or acknowledge anything.

`scope` is `{ "type": "application", "id": "application-uuid" }`.

Participant/author shape stays `{id,displayName,role}` (author can be null if unavailable). Application roles are `publisher`, `applicant`, `proposed_participant`. The applicant appears once even when also in `application_members`. Neither an applicant nor an unconfirmed proposed participant is called a signed collaborator. Agreement/order roles remain unchanged.

## Additive applicationContext

Present on every application `GET /conversations` page, absent on agreement/order pages and on other discovery DTOs. All six properties are always present:

```json
{
  "applicationId": "application-uuid",
  "applicationState": "applied",
  "taskStatus": "open",
  "canSend": true,
  "sendUnavailableReason": null,
  "agreementId": null
}
```

`applicationState`: applied | invited | withdrawn | declined | superseded | accepted.
`taskStatus`: open | contracted | closed.
`canSend`: boolean describing current read-time availability, never authority for a later request.
`sendUnavailableReason`: null | account_restricted | membership_required | application_closed | task_closed. Reasons use this precedence: restricted account, invalid campus membership, terminal application, non-open task. Both restricted and expired is reported as account_restricted here; the existing write gate may return membership_required first.
`agreementId`: exact agreement whose `application_id` equals this application and whose current `campus.in_agreement` permits this actor, otherwise null. No other application's agreement is offered; lookup does not expose its existence. Task titles are absent from this context.

## Delivery recovery contract

Send order is scope/account authorization → idempotency lookup/first execution → authorization again. Existing permission and membership gates apply to both new sends and receipt replay. The same actor, operation `message.send`, key and normalized body/scope identifies one request. The server does not rewrite old receipts.

| Result | Meaning and client recovery |
|---|---|
| 201 original receipt | Committed message confirmed. Authorized identical replay returns the same receipt even after application/task closure. Adds no message, receipt or notification. |
| 409 `idempotency_conflict` | Key already belongs to a different normalized request. Do not resend changed content with that key or reinterpret it as uncommitted. |
| 409 `application_conversation_closed` | **Definitive no-record for this key.** The actor passed current send authority, no existing receipt was found, and the INSERT guard refused the closed application/task. Transaction rolls back; no message, notification or receipt was created. UI should stop the unknown-delivery state, preserve the local draft and show that discussion is closed. |
| 403 `account_restricted` / `membership_required`, 403 locked, 404 unavailable | Current authority fails before a cached receipt can be exposed. This response alone is not a historical no-record proof; a prior committed request might exist. Preserve unresolved draft/key appropriately. |
| Transport failure/timeout or generic server failure | Delivery unknown. Retain the identical key/body/scope for an explicit authorized retry. Do not invent a receipt, create a fresh key automatically, or assume closure erased a committed message. |

The close-state guard runs only on INSERT (inside the idempotency first-execution callback). A stale `canSend=true` cannot override it. Scope validation intentionally excludes lifecycle closure so identical committed receipts can still be confirmed. Restricted/expired actors cannot use recovery to bypass current write gates.

## Database and serialization

014 adds nullable FK `messages.application_id → applications.id`, replaces `messages_check` with `messages_exactly_one_scope` over all three nullable IDs, and adds `(application_id,created_at DESC,id DESC)` partial history index. Old message rows gain SQL null in the additive column; their original columns and all old receipts/notifications remain unchanged.

`can_read_application_conversation(uuid)` checks current actor/non-locked account plus publisher/applicant/frozen-roster relation. It is used by additive message SELECT/INSERT policies. Sender must equal current actor. `conversation_people(text,uuid)` preserves agreement/order projections and adds application roles; it has no arbitrary-user mode. `application_conversation_context(uuid)` returns only authorized state/send availability/exact authorized agreement, no title/name snapshots.

`authorize_message_scope(text,uuid)` remains VOLATILE, SECURITY DEFINER with fixed `pg_catalog,campus,pg_temp` search path. The entire 013 agreement branch—including `member_locked`, current separate-statement `scope_ok` revalidation—and order/account/affiliation checks remain intact. Application sends discover authorized task ID, acquire the existing `hashtextextended('task:'||task_id,0)` transaction advisory lock, then task SHARE row, application SHARE row, actor application-member SHARE row, revalidate relation, then user and affiliation/domain/institution authority locks. This matches task transition task-first order. Authority locks remain through idempotency and post-receipt revalidation. Ordinary transitions and sends serialize on the same task lock.

The existing INSERT trigger invokes the authorization helper for the selected scope, then reads fresh application context and refuses terminal lifecycle. An ordinary campus_app INSERT cannot bypass active account, membership, scope or lifecycle checks. Trigger helpers have no EXECUTE grants to campus_app/auth/worker/PUBLIC. Read/authorize helpers are granted only to campus_app; new definers use a fixed search path. No broader users grants.

`notify_message_insert` preserves event identity `message:<message UUID>` and agreement/order recipient logic. Application recipients are the distinct publisher, applicant and all frozen application members (including unconfirmed), excluding sender. Only new inserts trigger events. Stored notifications contain no message body, copied task title or copied display name.

Notification application target remains `{type:"application",id,taskId?}`. Current members get authorized taskId/contextLabel; expired members keep `{type:"application",id}`, `contextLabel:null`, and currently authorized exact messageContext. Message context matches `event_key`, target type, target UUID, message scope and current RLS, using current authorized author names. Foreign mapping is null. Existing application action notifications and agreement/order DTOs are unchanged.

## Evidence and explicit limits

Task 1 focused suite: `tests/backend/application-conversations.test.mjs` (10 tests, disposable real PostgreSQL). Includes 143 message rows and 114 frozen participants, lifecycle/read/send/replay gates, strict parsing, direct app-role inserts, expired-title redaction and HTTP no-record semantics. Logs/report/hashes: `.superpowers/sdd/interaction-round10-plan/task-1-evidence/` and `task-1-report.md`.

Original legacy compatibility failures are retained rather than weakened: 012–013 inventory assertion rejects new 014; a 010-upgrade full-row JSON comparison sees additive `application_id:null`. Independent preservation/upgrade adaptation belongs to Task 2. No current-preview migration, full-suite certification, deployment, model inference or UI acceptance is claimed. **Execution-boundary correction:** the separate Round 8 forced-revocation diagnostic was not executed/recreated, but the existing advisory-key-wait/account-lock test DID run in both legacy attempts because the negative name filter failed to exclude it. Earlier skip claims were incorrect. Both unmodified logs and commands are retained; this is an unresolved evidence limitation/boundary breach, not passing permission or race proof. No further legacy run or exclusion experiment was performed after discovery.
