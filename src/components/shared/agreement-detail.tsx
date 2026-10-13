"use client";
import { useResource } from "./api";
import { Conversation } from "./conversation";
import { money, type Account, type Agreement } from "./types";
import { ResourceState, Status } from "./ui";
import { TargetDeliveryDate } from "./task-terms";
import { MilestonePanel } from "./fulfillment-milestone";
import { FulfillmentAnchor } from "./fulfillment-anchor";
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
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Collaboration agreement</span>
          <h1>{agreement.terms.taskTitle}</h1>
          <Status value={agreement.state} />
          <TargetDeliveryDate value={agreement.terms.dueDate} />
        </div>
        <div className="cb-reward">
          <small>Agreed reward</small>
          <strong>{money(agreement.terms.rewardCents)}</strong>
        </div>
      </div>
      {agreement.state === "awaiting_funding" && (
        <div className="cb-alert">
          <strong>Waiting for funding</strong>
          <p>
            The proposal and milestones are locked in. Work cannot be submitted
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
      <AgreementCompletion
        key={account.id}
        agreement={agreement}
        account={account}
        reload={resource.reload}
      />
      <p className="cb-prewrap">{agreement.terms.description}</p>
      <p>
        {agreement.members.length} signed collaborator
        {agreement.members.length === 1 ? "" : "s"} (publisher not included) ·{" "}
        {agreement.milestones.length} milestone
        {agreement.milestones.length === 1 ? "" : "s"}
      </p>
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
