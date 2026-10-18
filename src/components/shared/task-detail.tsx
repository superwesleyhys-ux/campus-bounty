"use client";
import { ListingManagement } from "./listing-management";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { historyDetailUrl } from "./history-pagination";
import { useEffect, useRef, useState } from "react";
import { useListingRequest } from "./listing-request";
import type { CommandResult, ApplicationTerms } from "./listing-types";
import { ApiError, useMutation, useResource } from "./api";
import {
  money,
  type Account,
  type Task,
  type Team,
  type Application,
} from "./types";
import { Feedback, Field, PendingButton, ResourceState, Status } from "./ui";
import { ReleaseDisclosure } from "./transaction-terms";
import { MilestoneRequirements, TargetDeliveryDate } from "./task-terms";
import { ApplicationCard } from "./application-card";

export function TaskDetail({
  id,
  account,
  openAgreement,
}: {
  id: string;
  account: Account;
  openAgreement: (id: string) => void;
}) {
  const router = useRouter(),
    query = useSearchParams();
  const proposalInput = useRef<HTMLTextAreaElement>(null);
  const task = useResource<Task>(`tasks/${id}`),
    applications = useResource<Application[]>(`tasks/${id}/applications`),
    teams = useResource<Team[]>(account.can_apply ? "teams" : null),
    saved = useResource<{ id: string; saved: boolean }>(`saved/tasks/${id}`);
  const mutation = useListingRequest<
      CommandResult<{ id: string }, ApplicationTerms>
    >(`${account.id}:task:${id}:apply`),
    save = useMutation(account.id),
    [proposal, setProposal] = useState(""),
    [teamId, setTeamId] = useState("");
  const proposalStorage = `campus:application-draft:${account.id}:${id}`;
  const [draftReady, setDraftReady] = useState(false);
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(proposalStorage) || "null");
      if (d) {
        setProposal(d.proposal || "");
        setTeamId(d.teamId || "");
      }
    } catch {}
    setDraftReady(true);
  }, [proposalStorage]);
  useEffect(() => {
    if (draftReady)
      try {
        localStorage.setItem(
          proposalStorage,
          JSON.stringify({ proposal, teamId }),
        );
      } catch {}
  }, [proposal, teamId, draftReady, proposalStorage]);
  async function submitApplication() {
    const r = await mutation.send(`tasks/${id}/applications`, {
      proposal,
      teamId: teamId || null,
      expectedRevision: task.data?.revision,
      expectedTermsVersion: task.data?.terms_version,
    });
    if (r) {
      try {
        localStorage.removeItem(proposalStorage);
      } catch {}
      applications.reload();
      router.push(
        historyDetailUrl(query, "workspace", r.receipt.id, "application"),
      );
    }
  }
  const t = task.data,
    isSaved = saved.data?.saved,
    alreadyApplied = applications.data?.find(
      (a) =>
        a.applicant_id === account.id &&
        ["applied", "invited", "accepted"].includes(a.state),
    );
  if (!t) return <ResourceState {...task} />;
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">{t.category} · Bounty</span>
          <h1>{t.title}</h1>
          <Status value={t.status} />
          <TargetDeliveryDate value={t.due_date} />
          <ReleaseDisclosure policy={t.release_policy} />
        </div>
        <div className="cb-reward">
          <small>Total reward</small>
          <strong>{money(t.reward_cents)}</strong>
          <button
            className="cb-button"
            aria-pressed={isSaved}
            disabled={
              save.busy || saved.loading || !!saved.error || !saved.data
            }
            onClick={async () => {
              const result = await save.run(
                `saved/tasks/${id}`,
                {},
                isSaved
                  ? "Removed from saved bounties."
                  : "Saved to your shortlist.",
                isSaved ? "DELETE" : "POST",
              );
              if (result) saved.reload();
            }}
          >
            {saved.error
              ? "Saved status unavailable"
              : isSaved === undefined
                ? "Checking saved status…"
                : isSaved
                  ? "Saved ✓"
                  : "Save bounty"}
          </button>
        </div>
      </div>
      <section className="cb-panel" aria-label="Apply or manage bounty">
        {t.owner_id === account.id ? (
          <>
            <h2>You published this bounty</h2>
            <p>
              You cannot apply to your own listing. Review applicants and open
              their chats below.
            </p>
            <a className="cb-button cb-primary" href="#bounty-applications">
              Review applications
            </a>
          </>
        ) : alreadyApplied ? (
          <>
            <h2>Your application is {alreadyApplied.state}</h2>
            <Link
              className="cb-button cb-primary"
              href={historyDetailUrl(
                query,
                "workspace",
                alreadyApplied.id,
                "application",
              )}
            >
              Chat about your application
            </Link>
          </>
        ) : t.status === "open" &&
          t.visibility === "published" &&
          account.can_apply ? (
          <>
            <h2>Interested in this bounty?</h2>
            <button
              className="cb-button cb-primary"
              disabled={!applications.data}
              onClick={() => {
                proposalInput.current?.focus();
                proposalInput.current?.scrollIntoView({ block: "center" });
              }}
            >
              Apply to this bounty
            </button>
          </>
        ) : (
          <p>
            {t.status !== "open"
              ? "Applications are closed. Existing conversations remain in Messages."
              : "Student eligibility is required to apply."}
          </p>
        )}
      </section>
      <Feedback {...save} />
      {mutation.pending && (
        <div className="cb-alert">
          <p>
            Your previous application may have completed. The exact proposal,
            listing version and request key are preserved.
          </p>
          <button
            className="cb-button"
            disabled={mutation.busy}
            onClick={() => void submitApplication()}
          >
            Recover application request
          </button>
        </div>
      )}
      {saved.error && <ResourceState {...saved} />}
      {t.status !== "open" && (
        <section className="cb-panel" aria-label="Recruitment and fulfillment">
          <h2>Recruitment closed</h2>
          <p>
            This bounty is no longer accepting applications. Recruitment status
            is separate from agreement fulfillment.
          </p>
          {t.related_agreement && (
            <>
              <p>
                Agreement fulfillment:{" "}
                <Status value={t.related_agreement.state} />
              </p>
              <Link
                className="cb-button"
                href={historyDetailUrl(
                  query,
                  "workspace",
                  t.related_agreement.id,
                  "agreement",
                )}
              >
                Open linked agreement
              </Link>
              {t.related_agreement.state === "completed" && (
                <p>
                  All milestones have been accepted. No funds were transferred.
                </p>
              )}
            </>
          )}
        </section>
      )}
      <ListingManagement
        listing={t}
        kind="task"
        account={account}
        reload={task.reload}
      />
      <div className="cb-detail-grid">
        <section>
          <div className="cb-panel">
            <h2>About the project</h2>
            <p className="cb-prewrap">{t.description}</p>
            <h2>Milestones & deliverables</h2>
            <ol className="cb-milestones">
              {t.milestones.map((m) => (
                <li key={m.id}>
                  <div className="cb-row">
                    <h3>{m.title}</h3>
                    <strong>{money(m.amount_cents)}</strong>
                  </div>
                  <MilestoneRequirements milestone={m} />
                </li>
              ))}
            </ol>
          </div>
          <h2 id="bounty-applications" tabIndex={-1}>
            {t.owner_id === account.id
              ? t.status === "open"
                ? "Applications to review"
                : "Application history"
              : "Your application & team proposals"}
          </h2>
          <ResourceState {...applications} />
          {applications.data?.length === 0 && (
            <p className="cb-muted">
              {t.owner_id === account.id
                ? t.status === "open"
                  ? "No applications yet. Share this page with your campus network."
                  : "No application history to show."
                : t.status === "open"
                  ? "Your proposals will appear here after you apply or join an applying team."
                  : "You have no application history for this bounty."}
            </p>
          )}
          {applications.data?.map((a) => (
            <section key={a.id} id={`application-${a.id}`} tabIndex={-1}>
              <ApplicationCard
                key={a.id}
                application={a}
                account={account}
                owner={t.owner_id === account.id}
                reload={() => {
                  applications.reload();
                  task.reload();
                }}
                openAgreement={openAgreement}
                discussionUrl={historyDetailUrl(
                  query,
                  "workspace",
                  a.id,
                  "application",
                )}
              />
            </section>
          ))}
        </section>
        <aside className="cb-panel cb-side-panel">
          <h2>
            {t.status !== "open"
              ? "Signed work and history"
              : t.owner_id === account.id
                ? "Your bounty"
                : "Make your case"}
          </h2>
          {t.visibility === "paused" ? (
            "This bounty is paused. Existing applications and agreements continue."
          ) : t.status !== "open" ? (
            <p>
              Recruitment is closed. Review existing applications and use the
              linked agreement to track signed work.
            </p>
          ) : t.owner_id === account.id ? (
            <p>
              Review proposals and invite an applicant once all team members
              have consented. The applicant then accepts your invitation.
            </p>
          ) : !account.can_apply ? (
            <>
              <p>
                Taking on a bounty requires current student eligibility. Check
                your status or request a review in Account.
              </p>
              <p>
                While you wait, save this bounty and return after approval to
                send your proposal.
              </p>
              <Link
                className="cb-button cb-primary"
                href="/?view=account#student-eligibility"
              >
                Check student eligibility
              </Link>
            </>
          ) : alreadyApplied ? (
            <p>
              You’ve applied. Track your proposal below and in Workspace. You
              can withdraw it before an agreement is created.
            </p>
          ) : t.status !== "open" ? (
            <p>This bounty is no longer accepting applications.</p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await submitApplication();
              }}
            >
              <Field label="Apply as">
                <select
                  disabled={mutation.busy || !!mutation.pending}
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">Just me</option>
                  {teams.data
                    ?.filter(
                      (t) =>
                        t.owner_id === account.id &&
                        t.status === "active" &&
                        t.own_state === "accepted",
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </Field>
              {teamId && (
                <p className="cb-fine">
                  Accepted members are included. Each must agree to this
                  specific proposal before the publisher can invite you.
                </p>
              )}
              <Field
                label="Your proposal"
                help="Describe your approach, relevant experience and how you’ll meet the target date and each milestone’s acceptance criteria."
              >
                <textarea
                  ref={proposalInput}
                  disabled={mutation.busy || !!mutation.pending}
                  required
                  maxLength={10000}
                  rows={6}
                  value={proposal}
                  onChange={(e) => setProposal(e.target.value)}
                />
              </Field>
              <Feedback error={mutation.error} />
              {mutation.error instanceof ApiError &&
                mutation.error.status === 409 && (
                  <button
                    type="button"
                    className="cb-button"
                    onClick={() => {
                      mutation.clear();
                      task.reload();
                      applications.reload();
                    }}
                  >
                    Reload and review current terms; keep proposal
                  </button>
                )}
              <p>
                Sending confirms your review of listing version{" "}
                {t.terms_version}. Team members must each review this version.
              </p>
              <PendingButton
                busy={mutation.busy}
                disabled={
                  !applications.data ||
                  !!mutation.pending ||
                  !mutation.ready ||
                  (mutation.error instanceof ApiError &&
                    mutation.error.status === 409) ||
                  task.loading
                }
              >
                Send application
              </PendingButton>
              <Link className="cb-text-button" href="/?view=teams">
                Manage your teams →
              </Link>
            </form>
          )}
          <div className="cb-divider" />
          {t.status === "open" && (
            <>
              <h3>What happens next?</h3>
              <ol>
                <li>Apply individually or with your team.</li>
                <li>The publisher reviews and invites.</li>
                <li>Accept and track milestones in Workspace.</li>
              </ol>
              <p className="cb-fine">
                The bounty publisher must fund the agreed reward before work
                starts. Payments are not available in this preview.
              </p>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
