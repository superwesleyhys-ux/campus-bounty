"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { ApiError, useMutation } from "./api";
import { type Account, type Application } from "./types";
import { Feedback, Status } from "./ui";
import { ApplicationTermsReview } from "./application-terms-review";
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
  const mutation = useMutation(account.id);
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
  async function act(action: string): Promise<boolean> {
    const r = await mutation.run<{ id: string }>(
      `applications/${a.id}/${action}`,
      {},
      action === "withdrawal"
        ? "Application withdrawn. Its history is kept."
        : "Application declined. The applicant can see this in their workspace.",
    );
    if (r) {
      reload();
      cardHeading.current?.focus();
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
      <ApplicationTermsReview
        id={a.id}
        account={account}
        reload={reload}
        openAgreement={openAgreement}
      />
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
