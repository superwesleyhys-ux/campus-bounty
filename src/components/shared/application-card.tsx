"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, useMutation, useResource } from "./api";
import { money, type Account, type Task, type Application } from "./types";
import { Feedback, ResourceState, Status } from "./ui";
import { MilestoneRequirements, TargetDeliveryDate } from "./task-terms";
import { ConfirmAction } from "./confirm-action";

export function ApplicationCard({
  application: a,
  account,
  owner = false,
  reload,
  openAgreement,
  discussionUrl,
}: {
  application: Application;
  account: Account;
  owner?: boolean;
  reload: () => void;
  openAgreement: (id: string) => void;
  discussionUrl?: string;
}) {
  const mutation = useMutation(account.id),
    mine = a.members.find((m) => m.user_id === account.id);
  const allConfirmed =
    a.members.length > 0 && a.members.every((m) => m.confirmed);
  const [review, setReview] = useState(false);
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const uncertain =
    !!mutation.error &&
    (!(mutation.error instanceof ApiError) ||
      mutation.error.status === 0 ||
      mutation.error.status >= 500);
  const clear = mutation.clear;
  useEffect(() => {
    if (["withdrawn", "declined", "superseded", "accepted"].includes(a.state))
      clear();
  }, [a.state, clear]);
  const reviewHeading = useRef<HTMLHeadingElement>(null),
    reviewButton = useRef<HTMLButtonElement>(null),
    wasReviewing = useRef(false);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (wasReviewing.current) reviewButton.current?.focus();
    wasReviewing.current = review;
  }, [review]);
  const terms = useResource<Task>(
    review && a.state === "invited" ? `tasks/${a.task_id}` : null,
  );
  const termsReady =
    !terms.loading && !terms.error && terms.data?.id === a.task_id;
  async function act(action: string): Promise<boolean> {
    if (action === "acceptance" && (!review || !termsReady)) return false;
    const r = await mutation.run<{ id: string }>(
      `applications/${a.id}/${action}`,
      {},
      action === "consent"
        ? "Your consent is recorded."
        : action === "invitation"
          ? "Invitation sent. The applicant must accept it."
          : action === "withdrawal"
            ? "Application withdrawn. Its history is kept."
            : action === "rejection"
              ? "Application declined. The applicant can see this in their workspace."
              : "Agreement created.",
    );
    if (r) {
      reload();
      if (action === "acceptance") openAgreement(r.id);
      else if (["withdrawal", "rejection"].includes(action)) {
        wasReviewing.current = false;
        setReview(false);
        cardHeading.current?.focus();
      }
    }
    return !!r;
  }
  return (
    <article className="cb-panel">
      <div className="cb-row">
        <h3 ref={cardHeading} tabIndex={-1}>
          {a.team_id ? "Team proposal" : "Individual proposal"}
          {a.applicant_id === account.id ? " · You" : ""}
        </h3>
        <Status value={a.state} />
      </div>
      <p className="cb-prewrap">{a.proposal}</p>
      <p>
        {a.members.filter((m) => m.confirmed).length} of {a.members.length}{" "}
        participants have agreed to this proposal.
      </p>
      <details>
        <summary>Participant consent</summary>
        <ul>
          {a.members.map((m) => (
            <li key={m.user_id}>
              <span>
                {m.user_id === account.id
                  ? "You"
                  : m.display_name || "Team member"}
              </span>{" "}
              — {m.confirmed ? "Agreed" : "Waiting for consent"}
            </li>
          ))}
        </ul>
      </details>
      <p>
        <Link
          className="cb-button"
          href={
            discussionUrl ||
            `/?view=workspace&tab=applications&resource=application&id=${a.id}`
          }
        >
          Open application discussion
        </Link>
      </p>
      <Feedback {...mutation} />
      {mutation.error && (
        <button
          type="button"
          className="cb-button"
          disabled={mutation.busy}
          onClick={reload}
        >
          Refresh application status
        </button>
      )}
      {a.state === "applied" && mine && !mine.confirmed && (
        <button
          className="cb-button cb-primary"
          disabled={mutation.busy || !account.can_apply}
          onClick={() => void act("consent")}
        >
          Agree to this proposal
        </button>
      )}
      {a.state === "applied" && owner && (
        <>
          <button
            className="cb-button cb-primary"
            disabled={mutation.busy || !allConfirmed}
            onClick={() => void act("invitation")}
          >
            Invite this applicant
          </button>
          {!allConfirmed && (
            <p className="cb-fine">
              Every proposed member must agree before you can invite the team.
            </p>
          )}
        </>
      )}
      {a.state === "invited" && a.applicant_id === account.id && (
        <>
          {!review ? (
            <button
              ref={reviewButton}
              className="cb-button cb-primary"
              onClick={() => setReview(true)}
            >
              Review invitation
            </button>
          ) : (
            <div className="cb-alert">
              <h4 ref={reviewHeading} tabIndex={-1}>
                Review the bounty terms
              </h4>
              <ResourceState {...terms} />
              {termsReady && terms.data && (
                <>
                  <p>
                    <strong>{terms.data.title}</strong>
                  </p>
                  <p className="cb-prewrap">{terms.data.description}</p>
                  <p>
                    Total reward:{" "}
                    <strong>{money(terms.data.reward_cents)}</strong>
                  </p>
                  <TargetDeliveryDate value={terms.data.due_date} />
                  <ol className="cb-milestones">
                    {terms.data.milestones.map((m) => (
                      <li key={m.id}>
                        <p>
                          <strong>
                            {m.title} · {money(m.amount_cents)}
                          </strong>
                        </p>
                        <MilestoneRequirements milestone={m} />
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <p>
                Accepting locks this proposal, team roster, target delivery date
                and milestone requirements into an agreement. Work must wait
                until funding is confirmed. Payments are not enabled in this
                preview.
              </p>
              <div className="cb-actions">
                <button
                  className="cb-button"
                  disabled={mutation.busy}
                  onClick={() => setReview(false)}
                >
                  Not now
                </button>
                <button
                  className="cb-button cb-primary"
                  disabled={mutation.busy || !account.can_apply || !termsReady}
                  onClick={() => void act("acceptance")}
                >
                  Accept invitation
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {a.state === "accepted" && (
        <Link className="cb-text-button" href="/?view=workspace&tab=agreements">
          Open workspace to view the agreement →
        </Link>
      )}
      {["applied", "invited"].includes(a.state) &&
        (owner || a.applicant_id === account.id) && (
          <ConfirmAction
            label={
              owner
                ? "Decline application"
                : a.state === "invited"
                  ? "Decline invitation"
                  : "Withdraw application"
            }
            description={
              owner
                ? "This proposal will no longer be considered. Its history is kept, and the applicant can submit a new proposal while this bounty is open."
                : "This application will close for you and any proposed team members. No agreement will be created. You can apply again while the bounty is open."
            }
            confirmLabel={
              owner
                ? "Confirm decline"
                : a.state === "invited"
                  ? "Confirm decline"
                  : "Confirm withdrawal"
            }
            busy={mutation.busy}
            uncertain={uncertain}
            onCheckStatus={() => {
              wasReviewing.current = false;
              setReview(false);
              cardHeading.current?.focus();
              reload();
            }}
            onConfirm={() => act(owner ? "rejection" : "withdrawal")}
          />
        )}
      {["withdrawn", "declined", "superseded"].includes(a.state) && (
        <p className="cb-fine">
          {a.state === "superseded"
            ? "Another applicant was selected for this bounty. This proposal is closed and kept in your history."
            : `${a.state === "withdrawn" ? "The applicant withdrew this proposal." : "The publisher declined this proposal."} It is kept in your history. A new proposal can be submitted while the bounty is open.`}
        </p>
      )}
    </article>
  );
}
