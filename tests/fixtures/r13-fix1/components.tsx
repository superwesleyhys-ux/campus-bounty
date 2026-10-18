import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAmendmentRequest } from "../../../src/components/shared/amendment-request";
import { useFulfillmentRequest } from "../../../src/components/shared/fulfillment-request";
import { AmendmentEditor } from "../../../src/components/shared/amendment-editor";
import { newAmendmentDraft } from "../../../src/components/shared/amendment-model";
import { AgreementSummary } from "../../../src/components/shared/agreement-summary";
import { AgreementCompletion } from "../../../src/components/shared/fulfillment-completion";
import { MilestonePanel } from "../../../src/components/shared/fulfillment-milestone";
const W = window as any;
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const account = { id: id(1), account_status: "active", campus_verified: true };
const stage = {
  id: id(3),
  position: 1,
  title: "Included accepted stage",
  amountCents: 1000,
  deliverable: "Original deliverable",
  acceptanceCriteria: "Original criteria",
};
const base = {
  id: id(4),
  agreementId: id(2),
  revision: 1,
  origin: "accepted_application",
  recordedAt: "2026-10-17T12:00:00Z",
  amendmentId: null,
  proposalRevision: null,
  terms: {
    taskTitle: "Fixture terms",
    description: "Original scope",
    dueDate: "2027-03-01",
    rewardCents: 1000,
    currency: "USD",
  },
  milestones: [stage],
};
const milestone = {
  id: stage.id,
  position: 1,
  title: stage.title,
  amount_cents: 1000,
  deliverable: stage.deliverable,
  acceptance_criteria: stage.acceptanceCriteria,
  state: "accepted",
  revision: 2,
  version: 1,
  lifecycle: "included",
};
const agreement = {
  id: id(2),
  owner_id: account.id,
  state: "active",
  terms: base.terms,
  effectiveTerms: base,
  agreementTermsBinding: "explicit",
  members: [],
  milestones: [milestone],
  milestone_counts: {
    total: 1,
    accepted: 1,
    submitted: 0,
    pending: 0,
    revision_requested: 0,
  },
};
W.fixture = { account, agreement, base, id, draft: newAmendmentDraft(base) };
let serial = 0;
const root = createRoot(document.getElementById("root")!);
function Hook({ kind, operation }: { kind: string; operation: string }) {
  const a = useAmendmentRequest(account.id, agreement.id);
  const f = useFulfillmentRequest(account.id, milestone.id, agreement.id);
  const h = kind === "amendment" ? a : f;
  const [success, setSuccess] = useState(0);
  W.probe = { phase: h.phase, error: h.error?.message, success };
  return (
    <>
      <p role="status">{h.phase}</p>
      <p role="alert">{h.error?.message}</p>
      <button
        disabled={h.phase === "loading" || h.phase === "sending"}
        onClick={async () => {
          const result =
            kind === "amendment"
              ? await a.send(operation as any, W.config.body, W.config.proposal)
              : await f.send(W.config.path, W.config.body);
          if (result) setSuccess((v) => v + 1);
        }}
      >
        Send or recover
      </button>
    </>
  );
}
function Editor() {
  const [open, setOpen] = useState(true),
    [actor, setActor] = useState(account.id);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open draft</button>
      <button
        onClick={() => {
          setOpen(false);
          setActor(actor === account.id ? id(9) : account.id);
        }}
      >
        Switch actor
      </button>
      {open && (
        <AmendmentEditor
          key={actor}
          account={{ ...account, id: actor } as any}
          agreement={agreement as any}
          blocked={false}
          conflict={false}
          close={() => setOpen(false)}
          publish={(body, done) => {
            W.lastPublished = body;
            done();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
function Retired() {
  const retired = {
    ...milestone,
    id: id(8),
    position: 2,
    title: "Retired historical stage",
    state: "pending",
    revision: 0,
    version: 0,
    lifecycle: "retired",
  };
  const included = {
    ...milestone,
    state: W.config.pending ? "pending" : "accepted",
    version: W.config.pending ? 0 : 1,
  };
  const g = {
    ...agreement,
    milestones: [included, retired],
    milestone_counts: {
      ...agreement.milestone_counts,
      accepted: W.config.pending ? 0 : 1,
      pending: W.config.pending ? 1 : 0,
    },
  };
  W.fixture.retiredAgreement = g;
  return (
    <>
      <AgreementSummary agreement={g as any} publisher />
      <AgreementCompletion
        agreement={g as any}
        account={account as any}
        reload={() => {}}
      />
      <MilestonePanel
        milestone={included as any}
        agreement={g as any}
        account={account as any}
        reload={() => {}}
      />
      <MilestonePanel
        milestone={retired as any}
        agreement={g as any}
        account={account as any}
        reload={() => {}}
      />
    </>
  );
}
W.mount = (mode: string, config: any = {}) => {
  W.config = config;
  root.render(
    mode === "editor" ? (
      <Editor key={++serial} />
    ) : mode === "retired" ? (
      <Retired key={++serial} />
    ) : (
      <Hook key={++serial} kind={config.kind} operation={config.operation} />
    ),
  );
};
