"use client";
import { useResource } from "./api";
import { Conversation } from "./conversation";
import { money, type Account, type Agreement } from "./types";
import { ResourceState, Status } from "./ui";
import { ReleaseDisclosure } from "./transaction-terms";
import { TargetDeliveryDate } from "./task-terms";
import { MilestonePanel } from "./fulfillment-milestone";
import { FulfillmentAnchor } from "./fulfillment-anchor";
import { AmendmentPanel } from "./amendment-panel";
import { TermsView } from "./amendment-comparison";
import { AgreementCompletion } from "./fulfillment-completion";

export function AgreementDetail({
  id,
  account,
}: {
  id: string;
  account: Account;
}) {
  const resource = useResource<Agreement>(`agreements/${id}`),
    agreement = resource.data;
  if (!agreement) return <ResourceState {...resource} />;
  const current = agreement.effectiveTerms?.terms ?? agreement.terms;
  const included = agreement.milestones.filter(
    (m) => m.lifecycle !== "retired",
  );
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">
            Collaboration agreement · Current terms
          </span>
          <h1>{current.taskTitle}</h1>
          <Status value={agreement.state} />
          <TargetDeliveryDate value={current.dueDate} />
        </div>
        <div className="cb-reward">
          <small>Current reward</small>
          <strong>{money(current.rewardCents)}</strong>
        </div>
      </div>
      {agreement.state === "awaiting_funding" && (
        <div className="cb-alert">
          <strong>Waiting for funding</strong>
          <p>
            The agreement is awaiting initial funding. Work cannot be submitted
            until funding is confirmed. Payments are not enabled in this
            preview, so you do not need to take any payment action here.
          </p>
        </div>
      )}
      {agreement.state === "completed" && (
        <p className="cb-alert cb-success" role="status">
          Agreement completed: every milestone has been accepted. This records
          fulfillment only; no funds were transferred or settled here.
        </p>
      )}
      <ReleaseDisclosure policy={agreement.transaction?.releasePolicy} />
      {agreement.transaction?.allocations && (
        <details className="cb-panel">
          <summary>Signed recipient amounts</summary>
          <ul>
            {agreement.transaction.allocations.map((c, i) => (
              <li key={`${c.member_id}:${c.stage_position}`}>
                {c.member_id === account.id ? "You" : `Recipient ${i + 1}`} ·
                stage {c.stage_position}: gross {money(c.gross_cents)} /
                estimated fee {money(c.recipient_fee_cents)} / estimated net{" "}
                {money(c.net_cents)}
              </li>
            ))}
          </ul>
          <p>
            Exact accepted allocation. No payment or transfer is proved by this
            binding.
          </p>
        </details>
      )}
      <AgreementCompletion
        key={account.id}
        agreement={agreement}
        account={account}
        reload={resource.reload}
      />
      <p className="cb-prewrap">{current.description}</p>
      <p>
        {agreement.members.length} signed collaborator
        {agreement.members.length === 1 ? "" : "s"} (publisher not included) ·{" "}
        {included.length} milestone
        {included.length === 1 ? "" : "s"}
      </p>
      <details className="cb-panel">
        <summary>Original terms</summary>
        {agreement.originalTerms ? (
          <TermsView
            value={agreement.originalTerms}
            label="Original agreement"
          />
        ) : (
          <>
            <h2>{agreement.terms.taskTitle}</h2>
            <p>
              {money(agreement.terms.rewardCents)} ·{" "}
              {agreement.terms.dueDate || "No target date"}
            </p>
            <p className="cb-prewrap">{agreement.terms.description}</p>
          </>
        )}
      </details>
      <AmendmentPanel
        key={`${account.id}:${id}`}
        agreement={agreement}
        account={account}
        reload={resource.reload}
      />
      <div className="cb-detail-grid cb-conversation-detail">
        <section>
          <FulfillmentAnchor>
            {agreement.milestones.map((m) => (
              <MilestonePanel
                key={`${account.id}:${m.id}`}
                milestone={m}
                agreement={agreement}
                account={account}
                reload={resource.reload}
              />
            ))}
          </FulfillmentAnchor>
        </section>
        <aside>
          <Conversation scope="agreementId" id={id} account={account} />
        </aside>
      </div>
    </>
  );
}
