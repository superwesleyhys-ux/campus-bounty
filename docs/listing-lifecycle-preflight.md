# Listing editing and visibility: current-source preflight

2026-10-17. Read-only preparation for the next product increment; not implemented or accepted. Round11 has passed local acceptance; the next implementation is now planned in interaction-round12-plan.md.

## Verified gap

The complete-interaction checklist still requires editing/unpublishing. backend-source-plan.md C6 requires versioned publishing, removal from display without deletion of transaction history; E1 permits OPEN↔PAUSED and says closing recruitment does not cancel agreements. Product orders must retain sold versions and price/license snapshots.

Current task/product modules expose list/detail/publish but no edit or visibility command. Existing detail API route trees likewise have no update/lifecycle routes. Publish UI stores browser drafts and submits new listings only. The public catalog queries do not filter an explicit visibility state. The current tasks constraint only has open/contracted/closed; products has no visibility field. These are source observations, not tested behavior of a future change.

## Existing contracts to preserve

| Surface | Current source evidence | Implication for implementation |
| --- | --- | --- |
| Task applications | tasks.mjs apply/invite checks open under task locking; applications have immutable proposal and member snapshots | Editing cannot silently alter what existing applicants/team members agreed to. Capture immutable task versions and bind new applications; require explicit re-review/reconfirmation where current terms change. Do not implement only a no-applicants special case and call editing complete. |
| Agreements | migration010 accept_task_invitation builds immutable agreement terms/milestones; agreements task_id is unique | Catalog changes or pausing must not rewrite signed agreements or cancel fulfillment. Agreement amendments remain a separate still-required workflow. |
| Product quotes | goods.mjs quote stores product_revision; migration006 create_order_from_quote validates revision, seller, amount, delivery and expiry with stock row lock | Edits and pausing must invalidate stale unconsumed quotes, preserve consumed order readback and normal stock release. |
| Inventory | order creation decrements stock; cancellation restores stock once | A seller update must not overwrite concurrent reservations/releases. Define available-stock adjustment semantics, revision/conflict handling and meaningful service tests. |
| Saved/own history | Round11 uses bounded actor/scope-bound cursor history and exact detail returns | Unpublished items must remain discoverable to their owner/history participants as appropriate. Public listing filters, own lists, saved cards and direct URLs need coherent states. Do not discard old transaction history or pagination context. |
| Command recovery | common command/idempotency and UI useMutation provide request recovery | Editing, pause and republish require expected revisions, stable request receipts, preserved drafts on conflict/failure, and visible current-state readback. |

## Boundaries for the next plan

- Implement both bounty and physical-product editing/visibility end to end, including owner controls, review/confirmation, stale form handling and public/own/history views. No automatic consequential submission by a tester on user records.
- Preserve existing migrations001–014. Any new migration needs isolated upgrade verification and an explicit preview-data preservation procedure; Round11's no-new-migration restriction remains in force until that increment ends. No live preview migration is authorized by this preflight note.
- Existing old applications do not store a task terms version. A migration cannot claim the currently observed listing was the exact historical text seen at submission. Distinguish legacy provenance and retain immutable signed agreement snapshots.
- Do not infer a new moderation/payment/refund policy or silently close unpaid/active obligations. Publishing review policy and full agreement changes remain within the full objective, separately implemented as their actual dependencies become available.
- Verification must include owner/nonowner/current-account checks, immutable prior versions and obligations, stale edit/quote rejection, idempotent recovery, public removal/republish, actual desktop/mobile UI and independent skill trial. Test ordinary business operations on synthetic isolated fixtures; preserve the existing exclusions on forced-revocation/paused-lock/raw-insert diagnostics.

Next action: execute interaction-round12-plan.md with schema/service foundation and a verified preview-upgrade gate before live integration. This preflight is not a feature delivery, not a completed test, and does not reduce the original full-application goal.
