# Development checkpoint — 2026-10-17

This private repository now includes work in progress, as requested by the owner. A sync commit is a source snapshot, not a release, deployment or passing whole-product acceptance. The original local workspace remains authoritative.

## Current state

- Existing application: Next.js plus PostgreSQL, English UI; listing lifecycle, personal/team applications, messages and notifications, team management, deliveries and physical-goods order workflows have bounded local evidence.
- Agreement changes: scoped backend/UI review completed; the original local preview's historical-data migration remains unresolved. Do not automatically migrate an existing database from this snapshot.
- Transactions: the first money-backend repair was independently reviewed and was NOT accepted. Four Important findings drove the second repair: later-fee hold recovery, a supported minimum-charge contract for small supplements, actionable Checkout recovery, and the supplemental operation-read schema. The second repair passed independent scoped specification and code-quality review: all four findings addressed, no new Critical/Important defect in that fix. This accepts the foundation for the next backend increment, not full Task2B, a release or production payments.
- Final verification for the second repair:29/29 targeted tests across16 payment files, passing type checking and isolated build, all bound to the same458 source files. Root independently verified the exact16-file change set, prior evidence preservation and cleanup of both disposable databases. Tests include signed minimum-aware amounts, exact-source reserve refunds, report-attributed later-fee recovery, Checkout action recovery, private operation reads, historical-v1 unknown-request identity preservation and new-v2 confirmation. These use synthetic transport and controlled clocks, not real provider execution. A separate defensive closure-origin branch was source-inspected but not executed; that limitation is retained explicitly in the review and cannot be treated as an executed path.
- The new signed supplemental plan separately discloses payer shortfall, supported provider minimum, exact collection, excess refundable reserve, collection profile and approved fee estimate. No silent increase of an old signed amount or recursive charge is permitted. Existing unknown requests must retain their original identity. Actual account-specific collection and billing authority have not been activated or verified.
- Mandatory monetary agreement amendments are now in implementation by a fresh Astra High agent: additive021, immutable previous funding, exact personally confirmed increments, aggregate/environment-effect reassessment, old/new component settlement and funded nonmonetary inheritance. No passing implementation claim yet. Complete payment UI, actual provider validation, production operator workflows and exceptional credit/tax/post-payout recovery policies remain outstanding. A history table or green subset does not complete these flows.
- Intermediate amendment checks now exercise a funded020→021 upgrade preserving preexisting table contents, both release choices, individual old/new source-charge transfers, an old stage paid before amendment, exact minimum boundaries, consent restrictions and relevant versus unrelated fee-report history. The report-history type error was repaired. Cancellation/withdrawal followed by a late received payment is being checked against the retained suspense liability and participant-visible status; the latest targeted run still has a failing assertion in that case. These are synthetic provider checks on an evolving snapshot, not a frozen accepted release. Independent review and final covering validation remain pending.
- Real university-email delivery/login, real payments/member bank payouts and production deployment are NOT verified. Synthetic test transport is not real service evidence.

## Where to read

- Full scope and outstanding work: `docs/interaction-completion.md`.
- Confirmed payment rules and delegated fee-cap choice: `docs/payment-policy-decisions.md`.
- Transaction specification: `docs/transaction-integration-contract.md`.
- API description: `docs/backend-openapi.json` (may evolve with in-progress changes).
- Polsia handoff: `docs/polsia-handoff-sync-001.md`.

Polsia's public page remains an older landing page. Polsia reported that it saved handoff knowledge record104231; its Product Roadmap was directly checked. This does not give Polsia private-repository access or establish automatic code import. Readability must be verified in its actual workspace before any integration claim.

## Safe use of this checkpoint

No deployment or real financial operations are authorized by this snapshot. Use disposable local fixtures for scoped tests. Do not execute unfiltered full-backend suites, forced revocation/paused-lock diagnostics, or raw-business-state reconstruction. Do not overwrite the authoritative local workspace from this export.

Secrets, credentials, local sessions/databases, raw logs/screenshots, backups and agent workspaces are excluded. Local evidence paths mentioned in historical delivery reports may therefore be unavailable here. Historical test counts describe their stated snapshots only; do not claim current complete acceptance from them.
