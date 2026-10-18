# Transaction integration — implementation plan

Status: in progress. Follows the user's request to connect transactions/login and use Polsia for integration gaps. The full website goal and Round13 original-preview reconciliation, skill trial and private sync remain open.

Authority: `backend-source-plan.md` F, current sources, `payment-policy-decisions.md`, and current user answers. `evidence/live-email/polsia-2026-10-17/result.md` records actual Polsia limits. Its merchant checkout cannot substitute for marketplace settlement. Preserve the existing source app.

## Task 1 — concrete payment contract and implementation map

Write `docs/transaction-integration-contract.md`, grounded in current routes/services/SQL. Cover bounty and goods payments; full upfront funding; explicit publisher-selected milestone/final release policy and immutable applicant/member consent; payee allocations; integer money; authorization; local/provider idempotency; durable attempts/outbox/inbox/ledger; webhook signature/account/environment/object/amount/currency checks; duplicate/out-of-order/unknown outcomes; acceptance eligibility versus transfer versus bank payout; cancellation/refund/dispute/reservation expiry; and signed agreement amendments. Bind each operation to exact versions and amounts. Identify concrete additive migrations, service/route/UI files and dependencies.

The user confirmed team-submitted allocation ratios, explicit confirmation by all members, and separate payouts to members; initial platform service fee is zero. The user also confirmed payment-provider fees are shared 50% by publisher and 50% by recipients; the team recipient half is divided by the unanimously confirmed reward ratios. These are now binding decisions. Actual fee adjustment, taxes and other unconfirmed policies remain explicit gates; do not invent defaults. Historical agreements without a chosen release policy remain unknown, never retroactively consented.

Verify Stripe Connect separate charges and transfers as the existing candidate, hosted Checkout and sandbox first; never call it legal escrow. Read the installed Stripe skills and local Connect/Payments references; verify current official APIs before implementation. Root separately handles tooling and isolated sandbox provisioning. This design task makes no provider calls and creates no accounts. No real money is authorized.

Include a requirement-to-test matrix covering deterministic checks, real isolated DB, actual provider sandbox receipts/events, browser journeys and independent skill trial. Mock events never prove provider acceptance. Define each visible success condition, exact endpoints/DTOs, failure states and the minimum safe implementation sequence. Avoid a generic architecture essay.

## Task 2 — implementation

After scoped design review, implement the schema, service, adapter, worker, endpoints and policy-bound user flow in the existing app. Use a new valid isolated fixture environment. Preview016 stays untouched pending historical reconciliation; no failed017 retry. Installed001–016 are immutable; accepted017 stays frozen. Future schema changes are additive. External sandbox work needs an exact target release. No live keys/funds or secrets in logs.

### Implementation sequence

- **2A**: transaction terms, deterministic fee/component amounts, release-policy capture, team allocation proposals and individual confirmations, immutable agreement binding and the existing user-facing terms/consent UI. Legacy unknown policies stay unknown; this does not mark funds received.
- **2B**: authoritative ledger/operations, provider adapter, signed inbox/outbox, funding/eligibility, order expiry/cancellation, refund/dispute/reconciliation and amendment funding.
- **2C**: complete quote/Checkout/recovery/onboarding/settlement UI and actual sandbox integration across both release choices, teams and goods.

Each increment receives scoped independent review. Full Task2 and the complete goal remain open until every part is implemented and Task3 evidence passes.

## Task 3 — actual acceptance

Fresh visible UI login in the supported synthetic environment; application/contract → full funding → submission/acceptance → release → transfer status; plus goods expiry/payment cases. Exercise both release choices and confirmed team policy. Record actual signed provider-sandbox webhooks separately from mocks. Fresh independent skill trial, one combined final fix/review, then sanitized private GitHub sync. Real email/login and production payment activation still need separate actual evidence and operator setup.

## Working constraints

Authoritative checkout `/Users/huangyusen/Desktop/悬赏令/campus-bounty-backend`, branch `codex/bounty-task-terms`, HEAD `cab5ba477abab3e1527a7193a2d2e3cb5a4978e5`. Preserve uncommitted work/evidence; snapshot-relative diffs, no source commit/reset/clean. One implementer at a time, no nested agents, Astra High requested. Existing SDD workflow applies. Do not rerun completed tests for counts; no full backend suite.

Never run or reconstruct `send gate remains held during key wait and rechecks clock expiry before releasing a cached receipt`, `tests/independent/conversations/message-revocation-race-diagnostic.mjs`, or `tests/independent/final-race/blocked-followup-test-source.mjs`. No forced-revocation, paused-lock or raw-business-insert diagnostics. No original preview restart/reseed/worker or old-record mutation. Original bounty `f55219de-c35f-4b07-afbb-7264342a42f5` and R11/R12 fixtures are read-only. Builds only `CAMPUS_BUILD_DIR=.next-release CAMPUS_BACKEND=postgres CAMPUS_DEMO=0 npm run build`. Skills grant no extra account/billing/publishing authority. Report actual scope, failures and unverified obligations each loop.
