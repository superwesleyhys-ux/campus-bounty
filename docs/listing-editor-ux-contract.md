# Round 12 listing editor and changed-terms review UI contract

Prepared from the current Campus Bounty UI and frontend-ui-engineering skill. This is an implementation contract for Task2, not a rendered feature or a usability-test result. Backend field names/actions follow Task1's reviewed handoff, not invented DTOs here.

## Current integration surfaces (source checked)

The PostgreSQL preview uses `src/components/shared/app.tsx`, selected by `src/app/page.tsx`; `src/components/campus.tsx` is the separate local-only branch. Implement the editor in the active shared application. Confirm the deployed entry remains on the same backend branch.

Update both application surfaces: the reusable `application-card.tsx` and exact `application-detail.tsx` currently display the old member `confirmed` flag. Current-version consent and invitation state must remain consistent across detail, Workspace, and the task's applications list. Inspect `task-detail.tsx` apply submission and the existing consent/invitation/acceptance routes when wiring the reviewed versioned service contracts.

The publish review currently says “Listing terms cannot be edited after publishing in this version.” Replace this obsolete claim when editing becomes available; explain that signed agreements and existing orders retain their terms. Include the updated copy in the ordinary publish-to-edit journey verification. Current quote/order routes and product-detail controls must show paused/stale states consistently with backend enforcement. These are integration requirements, not claims that these paths have changed yet.

## References inspected

- Existing Publish form: current labelled task/product fields, budget/date validation, browser draft and review step.
- TeamContextEditor and ConfirmAction: explicit confirmation, visible current saved values, conflict/unknown request distinction, cancel focus restoration.
- Current shared.css: existing cb ink/muted/blue/border/paper tokens, Arial typography, visible keyboard outline and established button/panel spacing. No visual redesign or new component library.
- Actual prior screenshots viewed: docs/evidence/interaction-round5/dogfood/screenshots/editor-320.png (compact modal with long content) and .superpowers/sdd/interaction-round11-plan/final-fix-browser-run1/old-saved-detail-1440.png (detail hierarchy and saved/history context). These are references, not fresh Round12 tests.

The editor's larger milestone form merits a full content page rather than placing all fields inside the short team modal. Preserve current navigation and exact history origin. A conflict comparison must be readable in one mobile column; no horizontally scrolling desktop diff.

## Entry and screen jobs

| Screen | Primary job/action | Required secondary state |
| --- | --- | --- |
| Own bounty/product detail | Visible Edit bounty / Edit listing near title; one clear owner action group | Text visibility state and independently stated recruitment/fulfillment status; current version; appropriate Pause listing or Republish action |
| Workspace My bounties/My listings | Find an owned item and its edit action without another hidden settings page | Keep history cursor and item identity through editor and Back; pause is visible in list row |
| Editor | Change values, then Review changes | Current saved version, local draft status, Cancel editing; required/optional labels; no network write from changing a field or merely entering Review |
| Review | Read changed fields, consequences and Save changes | Before/after or Added/Removed labels; milestone additions/deletions and money/date changes; Back to editing; no fake changed count |
| Updated application | Review updated terms for this application, then explicitly confirm the displayed version | Prior submitted terms if known, current exact version, own consent and remaining required member review, publisher invitation version; original proposal/chat/withdrawal still reachable |
| Publisher review | See who has reviewed current terms and send a fresh invitation when eligible | No stale Invited/Confirmed badge implying the previous version still applies; no auto-invite following edit |

## Editor fields and interaction

Use the existing publish validation rules and form primitives. Task fields include title, category, description, reward, target date, ordered milestones, deliverables, amounts and acceptance criteria. Keep original milestone rows keyed stably while editing; accessible add/remove buttons name the milestone. Show budget sum and mismatch next to the milestone section, not only a generic toast. Product fields include price, shipping/pickup choices, shipping amount and available stock. Explain stock as currently available units; reserved orders remain separate. A fresh server stock conflict must never silently overwrite it.

Use dollar inputs and the existing cents/date conversion helpers. Errors focus an error summary or first invalid field and identify the precise label. The final review shows exact changed values; hiding a field because delivery mode changed cannot leave stale hidden shipping terms in the submitted body. Save creates a version and updates the visible current state only after confirmed result/readback.

Persist drafts by account, listing kind and exact ID, including their baseline revision. Restore only the same identity's draft; never replace it with a later fetch. Cancelling with edits offers Keep editing / Discard changes and returns focus to the launching action. Browser Back/reload must have a predictable saved-draft path; preserve originating Workspace/Saved cursor with the existing historyDetailUrl contract. No draft contents in query strings.

## Pause and republish

Use an explicit inline confirmation with a concrete consequence statement: the item leaves public browsing and new applications/purchases stop; existing agreements/orders continue. Provide a non-destructive cancel action. Paused detail offers a visible reason/new-action-disabled state and owner republish control. Other members never see owner controls; server still checks authorization. Re-publishing a contracted bounty must not suggest a new agreement slot has opened. Show recruitment and visibility as separate facts if their states differ.

## Changed application terms

Keep submitted proposal and frozen members unchanged. Show the participant what changed, then an unchecked, explicit confirmation for the current exact version. Viewing the page, opening chat, accepting a team invitation or scrolling does not count as confirmation. Current-member review must list who still needs to act using existing authorized participant labels; do not expose other applicants. All version acknowledgements apply only to the displayed version. A newer edit during review clears eligibility and presents the new comparison, never silently sends old checked state for a new version.

Prior invitation details remain historical; show that a fresh publisher invitation is required after changed terms. Acceptance reviews the fresh invitation's exact current terms. Terminal applications remain history, not a prompt to consent again. Signed agreements retain their original/current agreement terms and existing fulfillment link; editing the listing does not amend that agreement.

For legacy records whose original submission terms are unknown, say so plainly, e.g. “Earlier submission terms were not recorded. Review the current terms before continuing.” Do not fabricate an original-version comparison or present the migration snapshot as historical consent. Only show this limitation where it affects the decision.

## Recovery state contract

| State | User sees | Permitted next step |
| --- | --- | --- |
| Loading | Contextual loading message, no guessed editable values | Retry on failure; no enabled save until authorized exact current data exists |
| Draft ready | Restored/current inputs and saved-on-this-device status | Edit or review; input changes are local only |
| Saving | Clearly named pending action, no duplicate submission | Wait; retain original request data |
| Confirmed success | Saved version and visible current saved values | Return to original list/detail or continue editing from a new baseline |
| Version/stock conflict | Current saved values next to unchanged draft; specific conflict reason | Deliberately review latest baseline and draft, then review again before a new write |
| Unknown outcome | Request may have completed; original draft/request frozen | Check current state and retry the same original request to resolve its receipt; no new version/key from a blind retry |
| Recovered old receipt | Original update result distinguished from newer current state | Show both without claiming an older receipt is the current version |
| Permission lost/account switched | Current restriction and safe navigation | Clear former account data; do not allow a late response to restore private form/state |

## Responsive and accessibility finish gate

Task2 must inspect the actual rendering at320,390,768,1024 and1440. Run full business scenarios at390/1440 and targeted layout checks at the other widths. Single-column long-field comparisons on narrow screens, readable wrapping for long title/criteria, native labelled controls, visible focus, and at least44px primary touch controls. Top/detail heading should reveal the actual action, not a large decorative banner. Do not rely only on colors, icon-only owner menus or hover.

Use one live status announcement per operation; do not steal focus on background refresh. On review/confirmation/meaningful error transitions, move focus deliberately; on cancel return it. Any modal used only for short confirmation must trap focus, label itself and handle Escape according to whether a request is unresolved. Do not blanket-copy a textarea-only focus query into a mixed-field editor.

Verify keyboard traversal and relevant axe states, loading/permission/empty/error/conflict/unknown/success views. Inspect screenshots of the actual final code, and preserve failures. This contract itself is not that verification.
