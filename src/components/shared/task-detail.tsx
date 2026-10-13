"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useResource } from "./api";
import {
  money,
  type Account,
  type Task,
  type Team,
  type Application,
} from "./types";
import { Feedback, Field, PendingButton, ResourceState, Status } from "./ui";
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
  const task = useResource<Task>(`tasks/${id}`),
    applications = useResource<Application[]>(`tasks/${id}/applications`),
    teams = useResource<Team[]>(account.can_apply ? "teams" : null),
    saved = useResource<Task[]>("saved/tasks");
  const mutation = useMutation(account.id),
    save = useMutation(account.id),
    [proposal, setProposal] = useState(""),
    [teamId, setTeamId] = useState("");
  const t = task.data,
    isSaved = saved.data?.some((v) => v.id === id),
    alreadyApplied = applications.data?.some(
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
        </div>
        <div className="cb-reward">
          <small>Total reward</small>
          <strong>{money(t.reward_cents)}</strong>
          <button
            className="cb-button"
            aria-pressed={!!isSaved}
            disabled={save.busy || !saved.data}
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
            {isSaved ? "Saved ✓" : "Save bounty"}
          </button>
        </div>
      </div>
      <Feedback {...save} />
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
                href={`/?view=workspace&tab=agreements&resource=agreement&id=${t.related_agreement.id}`}
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
          <h2>
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
          {t.status !== "open" ? (
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
                const r = await mutation.run(
                  `tasks/${id}/applications`,
                  { proposal, teamId: teamId || null },
                  "Application sent. Track it in your workspace.",
                );
                if (r) {
                  applications.reload();
                  setProposal("");
                }
              }}
            >
              <Field label="Apply as">
                <select
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
                  required
                  maxLength={10000}
                  rows={6}
                  value={proposal}
                  onChange={(e) => setProposal(e.target.value)}
                />
              </Field>
              <Feedback {...mutation} />
              <PendingButton busy={mutation.busy} disabled={!applications.data}>
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
