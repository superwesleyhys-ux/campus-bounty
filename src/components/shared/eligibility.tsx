"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "./api";
import type { Account } from "./types";
import { Feedback, Field, PendingButton, ResourceState, Status } from "./ui";
import {
  eligibilityDate,
  requestStatus,
  resultUncertain,
  useEligibilityPages,
  type EligibilityRequest,
} from "./eligibility-types";

export function EligibilityPagination({
  page,
  nextCursor,
  busy,
  previous,
  next,
}: {
  page: number;
  nextCursor?: string | null;
  busy: boolean;
  previous: () => void;
  next: () => void;
}) {
  if (page === 1 && !nextCursor) return null;
  return (
    <nav className="cb-actions" aria-label="Eligibility request pages">
      <button
        className="cb-button"
        disabled={busy || page === 1}
        onClick={previous}
      >
        Previous page
      </button>
      <span>Page {page}</span>
      <button
        className="cb-button"
        disabled={busy || !nextCursor}
        onClick={next}
      >
        Next page
      </button>
    </nav>
  );
}

function RequestHistory({ item }: { item: EligibilityRequest }) {
  return (
    <article className="cb-panel">
      <div className="cb-row">
        <h3>{item.institution_name}</h3>
        <Status value={requestStatus(item)} />
      </div>
      <p className="cb-fine">Submitted {eligibilityDate(item.created_at)}</p>
      <p className="cb-prewrap">{item.enrollment_summary}</p>
      {item.reviewed_at && <p>Reviewed {eligibilityDate(item.reviewed_at)}</p>}
      {item.review_reason && (
        <p className="cb-prewrap">
          <strong>Review explanation:</strong> {item.review_reason}
        </p>
      )}
      {item.valid_until && (
        <p>Approval valid until {eligibilityDate(item.valid_until)}</p>
      )}
    </article>
  );
}

function EligibilitySummary({
  account,
  pending,
  latest,
  expired,
}: {
  account: Account;
  pending: boolean;
  latest?: EligibilityRequest;
  expired: boolean;
}) {
  return (
    <>
      <p>
        Institution:{" "}
        <strong>{account.institution_name || "No current institution"}</strong>
      </p>
      <p>
        University email verification and student eligibility are separate. An
        authorized reviewer checks your enrollment before you can apply to
        bounties or join teams.
      </p>
      <p className="cb-fine">
        Your review request is visible to you and platform-authorized reviewers
        for your institution. Other campus members cannot view it.
      </p>
      {account.can_apply && (
        <p>
          You can apply to bounties and join teams. Student approval is valid
          until {eligibilityDate(account.student_valid_until)}.
        </p>
      )}
      {!account.can_apply && account.student_valid_until && (
        <p>
          Last student approval ends{" "}
          {eligibilityDate(account.student_valid_until)}.
        </p>
      )}
      {pending && (
        <>
          <p role="status">
            Your request is waiting for review. You can browse listings and
            check this page for a decision.
          </p>
          <p className="cb-fine">
            A review-time estimate and automatic notifications are not available
            yet. Return here and choose Refresh eligibility status to check for
            a decision.
          </p>
        </>
      )}
      {!pending && latest?.status === "rejected" && (
        <p className="cb-alert cb-prewrap">
          <strong>Your request was not approved.</strong> {latest.review_reason}{" "}
          Update your enrollment information below to request another review.
        </p>
      )}
      {expired && !pending && (
        <p>
          Your student approval has expired. Submit current enrollment
          information to renew it.
        </p>
      )}
      {!account.campus_verified && (
        <p className="cb-alert">
          Your university email verification has expired. Sign out using the
          button above, then sign in with the same university email and a new
          code. Return here after verification to request a student review.
        </p>
      )}
      {account.account_status !== "active" && (
        <p className="cb-alert">
          Your account is restricted. You can read your request history, but
          cannot submit a new request. An account administrator must resolve the
          restriction; signing in again or reapplying will not remove it.
        </p>
      )}
      {account.campus_verified && (
        <p className="cb-fine">
          University email verified until{" "}
          {eligibilityDate(account.affiliation_valid_until)}. Student approval
          cannot extend past that date.
        </p>
      )}
    </>
  );
}

export function Eligibility({
  account,
  onAccountChanged,
}: {
  account: Account;
  onAccountChanged: () => void;
}) {
  const pages = useEligibilityPages("me/eligibility-requests?limit=20");
  const mutation = useMutation(account.id);
  const [summary, setSummary] = useState(""),
    [attestation, setAttestation] = useState(false);
  const [recovered, setRecovered] = useState("");
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const submittedIds = useRef<Set<string> | null>(null);
  const latest = pages.first.data?.items[0];
  const pending = latest?.status === "pending";
  const uncertain = resultUncertain(mutation.error);
  const expired =
    !!account.student_valid_until &&
    new Date(account.student_valid_until).getTime() <= Date.now();
  const status =
    account.account_status !== "active"
      ? account.account_status
      : !account.campus_verified
        ? "verification_expired"
        : account.can_apply
          ? "approved"
          : !pages.first.data
            ? pages.first.error
              ? "status_unavailable"
              : "checking"
            : pending
              ? "pending"
              : latest?.status === "rejected"
                ? "rejected"
                : expired
                  ? "expired"
                  : "not_requested";
  const mayRequest =
    account.account_status === "active" &&
    account.campus_verified &&
    !account.can_apply &&
    !pending &&
    !!pages.first.data &&
    !pages.first.loading &&
    !pages.first.error;
  const clear = mutation.clear;
  useEffect(() => {
    if (!uncertain || !submittedIds.current || !pages.first.data) return;
    const found = pages.first.data.items.find(
      (item) => !submittedIds.current!.has(item.id),
    );
    if (found) {
      clear();
      setRecovered(
        "Your request was received. Its current status is shown below.",
      );
      setSummary("");
      setAttestation(false);
      submittedIds.current = null;
      statusHeading.current?.focus();
    }
  }, [pages.first.data, uncertain, clear]);
  function refresh() {
    pages.refresh();
    onAccountChanged();
    statusHeading.current?.focus();
  }
  return (
    <section
      id="student-eligibility"
      tabIndex={-1}
      aria-labelledby="eligibility-heading"
    >
      <div className="cb-panel">
        <div className="cb-row">
          <h2 id="eligibility-heading" ref={statusHeading} tabIndex={-1}>
            Student eligibility
          </h2>
          <Status value={status} />
        </div>
        <EligibilitySummary
          account={account}
          pending={pending}
          latest={latest}
          expired={expired}
        />
        <button
          type="button"
          className="cb-button"
          disabled={mutation.busy || pages.first.loading}
          onClick={refresh}
        >
          Refresh eligibility status
        </button>
        <Feedback {...mutation} />
        {pages.page > 1 && pages.first.error && (
          <ResourceState {...pages.first} />
        )}
        {recovered && (
          <p className="cb-alert cb-success" role="status">
            {recovered}
          </p>
        )}
        {uncertain && (
          <p className="cb-alert" role="status">
            Your request may already have been received. Refresh the status
            before making changes, or retry the same submission to recover its
            result. Your entries are kept.
          </p>
        )}
        {(mayRequest || uncertain) && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!summary.trim() || !attestation || mutation.busy) return;
              submittedIds.current ||= new Set(
                pages.first.data?.items.map((item) => item.id),
              );
              setRecovered("");
              const result = await mutation.run<EligibilityRequest>(
                "me/eligibility-requests",
                { enrollmentSummary: summary.trim(), attestation: true },
                "Request submitted. An authorized reviewer will check your student eligibility.",
              );
              if (result) {
                setSummary("");
                setAttestation(false);
                submittedIds.current = null;
                pages.reset();
                onAccountChanged();
                statusHeading.current?.focus();
              }
            }}
          >
            <h3>
              {latest ? "Request another review" : "Request a student review"}
            </h3>
            <Field
              label="Current enrollment information"
              help="Briefly describe your current program, enrollment status and academic term. Do not include student ID numbers, government IDs, passwords or financial information."
            >
              <textarea
                value={summary}
                required
                maxLength={1000}
                rows={5}
                disabled={mutation.busy || uncertain}
                onChange={(event) => {
                  setSummary(event.target.value);
                  mutation.clear();
                  setRecovered("");
                  submittedIds.current = null;
                }}
              />
            </Field>
            <label className="cb-check">
              <input
                type="checkbox"
                checked={attestation}
                required
                disabled={mutation.busy || uncertain}
                onChange={(event) => setAttestation(event.target.checked)}
              />
              <span>
                I confirm that this enrollment information is accurate and
                current. I understand that submitting this request does not
                grant student eligibility.
              </span>
            </label>
            <PendingButton
              busy={mutation.busy}
              disabled={!summary.trim() || !attestation}
            >
              {uncertain ? "Retry the same request" : "Submit review request"}
            </PendingButton>
          </form>
        )}
      </div>
      <h2 ref={historyHeading} tabIndex={-1}>
        Your review history
      </h2>
      <ResourceState {...pages} />
      {pages.data?.items.length === 0 && <p>No student review requests yet.</p>}
      {pages.data?.items.map((item) => (
        <RequestHistory key={item.id} item={item} />
      ))}
      <EligibilityPagination
        page={pages.page}
        nextCursor={pages.data?.nextCursor}
        busy={pages.loading}
        previous={() => {
          pages.previous();
          historyHeading.current?.focus();
        }}
        next={() => {
          pages.next();
          historyHeading.current?.focus();
        }}
      />
    </section>
  );
}
