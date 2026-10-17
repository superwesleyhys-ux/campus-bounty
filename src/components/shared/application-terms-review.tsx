"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, useResource } from "./api";
import { useListingRequest } from "./listing-request";
import { Feedback, ResourceState } from "./ui";
import type { Account } from "./types";
import type {
  ApplicationTerms,
  ApplicationReceipt,
  CommandResult,
} from "./listing-types";
import { ListingEventVersion } from "./listing-event-version";
import { TermsComparison, TermsView } from "./listing-terms";
type History = {
  items: {
    version: number;
    user_id?: string;
    task_revision?: number;
    created_at?: string;
    acknowledged_at?: string;
  }[];
  next: Record<string, string | number> | null;
  limit: number;
};
export function ApplicationTermsReview({
  id,
  account,
  reload,
  openAgreement,
}: {
  id: string;
  account: Account;
  reload: () => void;
  openAgreement: (id: string) => void;
}) {
  const resource = useResource<ApplicationTerms>(`applications/${id}/terms`),
    command = useListingRequest<
      CommandResult<ApplicationReceipt, ApplicationTerms>
    >(`${account.id}:application:${id}:terms`);
  const [checked, setChecked] = useState(false),
    [review, setReview] = useState(false),
    [history, setHistory] = useState<"acknowledgements" | "invitations" | null>(
      null,
    ),
    [cursor, setCursor] = useState<Record<string, string | number> | null>(
      null,
    );
  const h = useRef<HTMLHeadingElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    restoreTrigger = useRef(false);
  const d = !resource.loading && !resource.error ? resource.data : undefined;
  const historyQuery = new URLSearchParams({
    kind: history || "acknowledgements",
    limit: "10",
    ...Object.fromEntries(
      Object.entries(cursor || {}).map(([k, v]) => [k, String(v)]),
    ),
  });
  const page = useResource<History>(
    history ? `applications/${id}/terms/history?${historyQuery}` : null,
  );
  useEffect(() => {
    setChecked(false);
  }, [d?.listing.revision, d?.listing.terms_version, review]);
  useEffect(() => {
    if (!review && restoreTrigger.current && trigger.current) {
      restoreTrigger.current = false;
      trigger.current.focus();
      return;
    }
    if (review || command.error || command.result) h.current?.focus();
  }, [review, command.error, command.result]);
  async function act(action: "consent" | "invitation" | "acceptance") {
    if (!d && !command.pending) return;
    const r = await command.send(`applications/${id}/${action}`, {
      expectedRevision: d?.listing.revision,
      expectedTermsVersion: d?.listing.terms_version,
    });
    if (r) {
      setChecked(false);
      setReview(false);
      resource.reload();
      reload();
      if (action === "acceptance" && r.receipt.agreementId)
        openAgreement(r.receipt.agreementId);
    }
  }
  if (!d) return <ResourceState {...resource} />;
  const active = ["applied", "invited"].includes(d.application.state),
    owner = d.listing.owner_id === account.id,
    mine =
      d.application.applicant_id === account.id ||
      d.members.some((m) => m.user_id === account.id),
    missing = d.missingAcknowledgements.includes(account.id);
  const current = d.versions.find((v) => v.version === d.listing.terms_version),
    prior = d.versions.find(
      (v) => v.version === d.application.submitted_version,
    );
  const frozen = command.busy || !!command.pending,
    available =
      d.listing.visibility === "published" && d.listing.status === "open";
  const eligible =
    account.can_apply &&
    account.account_status === "active" &&
    account.campus_verified;
  const stale =
    command.error instanceof ApiError && command.error.status === 409;
  return (
    <section
      className="cb-application-terms"
      aria-label="Application listing terms"
    >
      <h3 ref={h} tabIndex={-1}>
        Listing version {d.listing.terms_version}
      </h3>
      <ListingEventVersion kind="task" id={d.listing.id} />
      <p>
        {d.listing.visibility === "paused"
          ? "Listing paused. Existing application history is retained."
          : "Current listing terms"}{" "}
        · revision {d.listing.revision}
      </p>
      {d.legacyProvenance && (
        <p className="cb-alert">
          Earlier submission terms were not recorded. The retained snapshot
          shows terms observed later, not historical consent. Review the current
          terms before continuing.
        </p>
      )}
      {!active ? (
        <p>
          This application is {d.application.state}. Its original proposal and
          frozen roster remain in history. Signed agreement terms are unchanged.
        </p>
      ) : (
        <>
          <ul>
            {d.members.map((m) => (
              <li key={m.user_id}>
                {m.user_id === account.id
                  ? "You"
                  : m.display_name || "Participant"}{" "}
                —{" "}
                {d.missingAcknowledgements.includes(m.user_id)
                  ? `Review required for version ${d.listing.terms_version}`
                  : `Confirmed version ${d.listing.terms_version}`}
              </li>
            ))}
          </ul>
          <p>
            {d.currentInvitation
              ? `Publisher invitation for version ${d.currentInvitation.version}, revision ${d.currentInvitation.task_revision}.`
              : "A fresh publisher invitation is required after every required participant confirms this version."}
          </p>
          {!review ? (
            <button
              ref={trigger}
              className="cb-button"
              disabled={frozen}
              onClick={() => setReview(true)}
            >
              Review current terms
            </button>
          ) : (
            <div className="cb-panel">
              <h4>Review version {d.listing.terms_version}</h4>
              {current && (
                <>
                  {prior &&
                  !d.legacyProvenance &&
                  prior.version !== current.version ? (
                    <TermsComparison
                      before={prior.terms}
                      after={current.terms}
                    />
                  ) : null}
                  <TermsView terms={current.terms} />
                </>
              )}
              {mine && eligible && (
                <label className="cb-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={frozen || stale}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  I have reviewed and agree to version {d.listing.terms_version}{" "}
                  and this application's frozen proposal and participants.
                </label>
              )}
              <div className="cb-actions">
                <button
                  className="cb-button"
                  disabled={frozen}
                  onClick={() => {
                    restoreTrigger.current = true;
                    setReview(false);
                  }}
                >
                  Close terms review
                </button>
                {mine && missing && (
                  <button
                    className="cb-button cb-primary"
                    disabled={
                      !checked || !eligible || frozen || stale || !available
                    }
                    onClick={() => void act("consent")}
                  >
                    Confirm version {d.listing.terms_version}
                  </button>
                )}
                {d.application.applicant_id === account.id &&
                  d.currentInvitation &&
                  !d.reviewRequired && (
                    <button
                      className="cb-button cb-primary"
                      disabled={
                        !checked || !eligible || frozen || stale || !available
                      }
                      onClick={() => void act("acceptance")}
                    >
                      Accept invitation for version {d.listing.terms_version}
                    </button>
                  )}
              </div>
              <p>
                Acceptance creates an agreement using these exact terms. Work
                waits for confirmed funding; payments are unavailable in this
                preview.
              </p>
            </div>
          )}
          {owner && (
            <button
              className="cb-button cb-primary"
              disabled={
                frozen ||
                stale ||
                d.reviewRequired ||
                !available ||
                !!d.currentInvitation ||
                !account.campus_verified ||
                account.account_status !== "active"
              }
              onClick={() => void act("invitation")}
            >
              Send invitation for version {d.listing.terms_version}
            </button>
          )}
        </>
      )}
      <Feedback error={command.error} />
      {command.pending && !command.busy && (
        <div className="cb-alert">
          <p>
            The previous request may have completed. Recover its original
            receipt before taking another action.
          </p>
          <button
            className="cb-button"
            onClick={() =>
              void act(
                command.pending!.path.endsWith("/acceptance")
                  ? "acceptance"
                  : command.pending!.path.endsWith("/invitation")
                    ? "invitation"
                    : "consent",
              )
            }
          >
            Recover previous request
          </button>
        </div>
      )}
      {command.result && (
        <p role="status">
          {command.result.replayed ? "Recovered original receipt" : "Confirmed"}
          :{" "}
          {command.result.receipt.originalAgreement
            ? "existing signed agreement"
            : `${command.result.receipt.operation} for version ${command.result.receipt.termsVersion}`}
          . Current listing version{" "}
          {command.result.current.listing.terms_version}, revision{" "}
          {command.result.current.listing.revision}.
        </p>
      )}
      <button
        className="cb-text-button"
        disabled={command.busy}
        onClick={() => {
          setChecked(false);
          setReview(false);
          command.clear();
          resource.reload();
          reload();
        }}
      >
        Refresh terms and invitation status
      </button>
      <details>
        <summary>Consent and invitation history</summary>
        <div className="cb-actions">
          {(["acknowledgements", "invitations"] as const).map((k) => (
            <button
              key={k}
              className="cb-button"
              onClick={() => {
                setHistory(k);
                setCursor(null);
              }}
            >
              {k === "acknowledgements"
                ? "View consent history"
                : "View invitation history"}
            </button>
          ))}
        </div>
        {history && (
          <>
            <ResourceState {...page} />
            <ul>
              {page.data?.items.map((item, i) => (
                <li key={i}>
                  Version {item.version}
                  {item.task_revision
                    ? ` · revision ${item.task_revision}`
                    : ""}
                  {item.user_id
                    ? ` · ${item.user_id === account.id ? "You" : d.members.find((m) => m.user_id === item.user_id)?.display_name || "Participant"}`
                    : ""}{" "}
                  ·{" "}
                  {new Date(
                    item.acknowledged_at || item.created_at || "",
                  ).toLocaleString("en-US")}
                </li>
              ))}
            </ul>
            {page.data?.next && (
              <button
                className="cb-button"
                onClick={() => setCursor(page.data!.next)}
              >
                Older history
              </button>
            )}
            {cursor && (
              <button className="cb-button" onClick={() => setCursor(null)}>
                Latest history
              </button>
            )}
          </>
        )}
      </details>
    </section>
  );
}
