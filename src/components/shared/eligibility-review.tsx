"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { request, useMutation } from "./api";
import type { Account } from "./types";
import { Feedback, Field, ResourceState, Status } from "./ui";
import { EligibilityPagination } from "./eligibility";
import {
  eligibilityDate,
  localDateTime,
  requestStatus,
  resultUncertain,
  useEligibilityPages,
  type EligibilityRequest,
} from "./eligibility-types";

type Decision = {
  decision: "approved" | "rejected";
  reason: string;
  validUntil?: string;
};

function ReviewDetails({
  item,
  account,
  headingRef,
}: {
  item: EligibilityRequest;
  account: Account;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      <div className="cb-row">
        <h2 ref={headingRef} tabIndex={-1}>
          {item.display_name}
        </h2>
        <Status value={requestStatus(item)} />
      </div>
      <p>
        {item.institution_name} · Submitted {eligibilityDate(item.created_at)}
      </p>
      <h3>Enrollment information</h3>
      <p className="cb-prewrap">{item.enrollment_summary}</p>
      <p className="cb-fine">
        University email verification expires{" "}
        {eligibilityDate(item.affiliation_valid_until)}.
      </p>
      {item.review_reason && (
        <p className="cb-prewrap">
          <strong>Review explanation:</strong> {item.review_reason}
        </p>
      )}
      {item.reviewed_at && <p>Reviewed {eligibilityDate(item.reviewed_at)}</p>}
      {item.valid_until && (
        <p>Approval valid until {eligibilityDate(item.valid_until)}</p>
      )}
      {item.user_id === account.id && (
        <p className="cb-alert">
          You cannot review your own request. Another authorized reviewer must
          decide it.
        </p>
      )}
      {item.status === "pending" && !item.membership_current && (
        <p className="cb-alert">
          Approval is unavailable because the applicant’s account or university
          verification is no longer current for this institution. They must
          resolve this before approval. You can still reject the request with an
          explanation so they can request a new review after restoring access.
        </p>
      )}
      {item.status === "pending" &&
        !item.can_review &&
        item.user_id !== account.id &&
        item.membership_current && (
          <p>This request is outside your current review permissions.</p>
        )}
    </>
  );
}

function DecisionConfirmation({
  item,
  confirmation,
  headingRef,
  uncertain,
  checking,
  busy,
  onCheckStatus,
  onEdit,
  onConfirm,
}: {
  item: EligibilityRequest;
  confirmation: Decision;
  headingRef: RefObject<HTMLHeadingElement | null>;
  uncertain: boolean;
  checking: boolean;
  busy: boolean;
  onCheckStatus: () => Promise<void>;
  onEdit: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="cb-alert">
      <h3 ref={headingRef} tabIndex={-1}>
        Confirm{" "}
        {confirmation.decision === "approved"
          ? "student approval"
          : "rejection"}
      </h3>
      <p>
        {confirmation.decision === "approved"
          ? `Approve ${item.display_name} until ${eligibilityDate(confirmation.validUntil)}? They will be able to apply to bounties and join teams while their account and verification remain valid.`
          : `Reject ${item.display_name}’s request? They can read your explanation and submit a new request.`}
      </p>
      <p className="cb-prewrap">
        <strong>Explanation:</strong> {confirmation.reason}
      </p>
      {uncertain && (
        <p role="status">
          This decision may already have been saved. Check its current status or
          retry the same decision to recover the result. It cannot be undone by
          closing this panel.
        </p>
      )}
      <div className="cb-actions">
        <button
          type="button"
          className="cb-button"
          disabled={busy || checking}
          onClick={() => (uncertain ? void onCheckStatus() : onEdit())}
        >
          {checking
            ? "Checking…"
            : uncertain
              ? "Check current status"
              : "Edit decision"}
        </button>
        <button
          type="button"
          className="cb-button cb-primary"
          disabled={
            busy ||
            checking ||
            (confirmation.decision === "approved" && !item.membership_current)
          }
          onClick={onConfirm}
        >
          {busy
            ? "Saving…"
            : uncertain
              ? "Retry the same decision"
              : "Confirm decision"}
        </button>
      </div>
    </div>
  );
}

function ReviewCard({
  item: original,
  account,
  refresh,
  resolved,
}: {
  item: EligibilityRequest;
  account: Account;
  refresh: () => void;
  resolved: (message: string) => void;
}) {
  const [observed, setObserved] = useState<EligibilityRequest | null>(null);
  const item = observed || original;
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<Error | null>(null);
  const [checkNotice, setCheckNotice] = useState("");
  const mutation = useMutation(account.id);
  const [decision, setDecision] = useState<Decision["decision"]>("rejected");
  const [reason, setReason] = useState(""),
    [until, setUntil] = useState("");
  const [confirmation, setConfirmation] = useState<Decision | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const uncertain = resultUncertain(mutation.error);
  const maxDate = new Date(
    Math.min(
      Date.now() + 365 * 86_400_000,
      item.affiliation_valid_until
        ? new Date(item.affiliation_valid_until).getTime()
        : Date.now(),
    ),
  );
  const authorized = item.can_review && item.user_id !== account.id;
  const clear = mutation.clear;
  useEffect(() => {
    setObserved(null);
  }, [original]);
  useEffect(() => {
    if (confirmation) confirmHeading.current?.focus();
    else if (wasConfirming.current) reviewButton.current?.focus();
    wasConfirming.current = !!confirmation;
  }, [confirmation]);
  useEffect(() => {
    if (item.status !== "pending") {
      clear();
      wasConfirming.current = false;
      setConfirmation(null);
    }
  }, [item.status, clear]);
  async function checkStatus() {
    if (checking || mutation.busy) return;
    setChecking(true);
    setCheckError(null);
    setCheckNotice("");
    try {
      const current = await request<EligibilityRequest>(
        `admin/eligibility-requests/${item.id}`,
      );
      setObserved(current);
      setCheckNotice(
        current.status === "pending"
          ? "This request is still awaiting review. The previous submission may still be processing; retry the same decision to recover its result."
          : `The recorded decision is ${current.status}. Its explanation and any expiry are shown in this request.`,
      );
      cardHeading.current?.focus();
    } catch (error) {
      setCheckError(error as Error);
    } finally {
      setChecking(false);
    }
  }
  return (
    <article className="cb-panel">
      <ReviewDetails item={item} account={account} headingRef={cardHeading} />
      <Feedback {...mutation} />
      <Feedback error={checkError} notice={checkNotice} />
      {mutation.error && !uncertain && (
        <button
          type="button"
          className="cb-button"
          disabled={mutation.busy}
          onClick={refresh}
        >
          Refresh review status
        </button>
      )}
      {item.status === "pending" &&
        authorized &&
        (!confirmation ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim()) return;
              const body: Decision = { decision, reason: reason.trim() };
              if (decision === "approved")
                body.validUntil = new Date(until).toISOString();
              mutation.clear();
              setConfirmation(body);
            }}
          >
            <Field label="Decision">
              <select
                value={decision}
                onChange={(event) =>
                  setDecision(event.target.value as Decision["decision"])
                }
              >
                <option value="rejected">Reject request</option>
                <option value="approved" disabled={!item.membership_current}>
                  Approve student eligibility
                </option>
              </select>
            </Field>
            <Field
              label="Review explanation"
              help="The applicant will see this explanation. State what you checked or what needs to change; do not include sensitive identification details."
            >
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
                maxLength={1000}
                rows={4}
              />
            </Field>
            {decision === "approved" && (
              <Field
                label="Student approval valid until"
                help="Choose an explicit future date and time in your device’s local time zone. It cannot be more than 365 days from now or exceed university email verification."
              >
                <input
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                  required
                  min={localDateTime(new Date(Date.now() + 60_000))}
                  max={localDateTime(maxDate)}
                />
              </Field>
            )}
            <button
              className="cb-button cb-primary"
              ref={reviewButton}
              type="submit"
              disabled={
                !reason.trim() ||
                (decision === "approved" && !item.membership_current)
              }
            >
              Review decision
            </button>
          </form>
        ) : (
          <DecisionConfirmation
            item={item}
            confirmation={confirmation}
            headingRef={confirmHeading}
            uncertain={uncertain}
            checking={checking}
            busy={mutation.busy}
            onCheckStatus={checkStatus}
            onEdit={() => {
              setConfirmation(null);
              mutation.clear();
            }}
            onConfirm={async () => {
              const result = await mutation.run<EligibilityRequest>(
                `admin/eligibility-requests/${item.id}/decision`,
                confirmation,
                "",
              );
              if (result)
                resolved(
                  `${item.display_name}’s request was ${result.status}. The decision and explanation are saved.`,
                );
            }}
          />
        ))}
    </article>
  );
}

function ReviewQueue({ account }: { account: Account }) {
  const [status, setStatus] = useState("pending"),
    [notice, setNotice] = useState("");
  const pages = useEligibilityPages(
    `admin/eligibility-requests?status=${status}&limit=20`,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  function refresh() {
    pages.reset();
    heading.current?.focus();
  }
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Authorized review</span>
          <h1 ref={heading} tabIndex={-1}>
            Student eligibility review
          </h1>
          <p>
            Review enrollment information for institutions you are authorized to
            manage. University email ownership alone does not establish student
            status.
          </p>
        </div>
      </div>
      <div className="cb-panel">
        <Field label="Request status">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              pages.reset();
              setNotice("");
            }}
          >
            <option value="pending">Pending review</option>
            <option value="approved">Approved (including expired)</option>
            <option value="rejected">Rejected</option>
            <option value="all">All requests</option>
          </select>
        </Field>
        <button
          type="button"
          className="cb-button"
          disabled={pages.loading}
          onClick={refresh}
        >
          Refresh review queue
        </button>
      </div>
      <Feedback notice={notice} />
      <ResourceState {...pages} />
      {pages.data?.items.length === 0 && (
        <p role="status">No requests match this status.</p>
      )}
      {pages.data?.items.map((item) => (
        <ReviewCard
          key={item.id}
          item={item}
          account={account}
          refresh={refresh}
          resolved={(message) => {
            setNotice(message);
            refresh();
          }}
        />
      ))}
      <EligibilityPagination
        page={pages.page}
        nextCursor={pages.data?.nextCursor}
        busy={pages.loading}
        previous={() => {
          pages.previous();
          heading.current?.focus();
        }}
        next={() => {
          pages.next();
          heading.current?.focus();
        }}
      />
    </>
  );
}

export function EligibilityReview({ account }: { account: Account }) {
  if (!account.can_review_eligibility)
    return (
      <section className="cb-panel">
        <h1>Student eligibility review</h1>
        <p>
          You do not have permission to review student eligibility. Only an
          authorized reviewer for the applicant’s institution can access these
          requests.
        </p>
      </section>
    );
  return <ReviewQueue account={account} />;
}
