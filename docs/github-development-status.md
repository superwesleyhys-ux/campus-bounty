# Development checkpoint — 2026-10-17

This private repository now includes work in progress, as requested by the owner. A sync commit is a source snapshot, not a release, deployment or passing whole-product acceptance. The original local workspace remains authoritative.

## Current state

- Existing application: Next.js plus PostgreSQL, English UI; listing lifecycle, personal/team applications, messages and notifications, team management, deliveries and physical-goods order workflows have bounded local evidence.
- Agreement changes: scoped backend/UI review completed; the original local preview's historical-data migration remains unresolved. Do not automatically migrate an existing database from this snapshot.
- Transactions: terms/consent foundation implemented. Money backend is in the first independent-review fix round. Fee reserve, original-charge restitution, pending-payment recovery, refunds, later-fee attribution and conflict blocking have targeted injected-provider tests. The current snapshot is not a frozen, independently accepted transaction release.
- Over-cap fees require fresh personal consent and verified supplemental funding. One targeted synthetic-provider test now completes the ordinary path through personal confirmation, payer-only supplemental collection, delayed fee/availability recovery, exact-source reserve restitution and recipient transfer. Its fixture collects 46 cents in supplemental reserve, settles 410 cents in total processing fees, returns 6 cents to the supplemental charge and transfers 9,795 cents to the recipient; journal cash ends at zero and original allocation records stay unchanged. This is a bounded backend test, not real payment or browser acceptance. A second targeted synthetic test now verifies unchanged request identity after a lost response, expired-payment recovery only through a newly confirmed revision, and no automatic recursive charge when supplementary fees exceed the signed cap; a later explicitly confirmed revision settles. Clear over-cap/current-versus-historical status projection, final regression/source binding and independent re-review remain pending. Monetary agreement amendments, complete payment UI and actual provider validation remain outstanding.
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
