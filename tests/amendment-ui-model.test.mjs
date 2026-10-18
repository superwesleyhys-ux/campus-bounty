// Compile only pure UI contracts into a temporary module; no application server/database.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "campus-r13-ui-model-"));
const source = fs.readFileSync(
  "src/components/shared/amendment-model.ts",
  "utf8",
);
fs.writeFileSync(
  path.join(temp, "model.mjs"),
  ts.transpile(source, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  }),
);
const { cents, newAmendmentDraft, draftBody } = await import(
  path.join(temp, "model.mjs")
);
const base = {
  id: "11111111-1111-4111-8111-111111111111",
  agreementId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  terms: {
    taskTitle: "Test",
    description: "Scope",
    dueDate: null,
    rewardCents: 1000,
  },
  milestones: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      position: 1,
      title: "First",
      amountCents: 1000,
      deliverable: "Report",
      acceptanceCriteria: null,
    },
  ],
};
function valid() {
  const d = newAmendmentDraft(base);
  d.reason = "A deliberate change";
  d.dueDate = "2027-02-28";
  return d;
}
test("decimal amounts use integer cents and reject exponent/rounding/overflow", () => {
  assert.equal(cents("0.29"), 29);
  assert.equal(cents("1000000.00"), 100000000);
  for (const bad of ["0", "1.001", "1e2", "-1", "Infinity", "1000000.01"])
    assert.throws(() => cents(bad));
});
test("full draft retains exact base and unchanged protected identity", () => {
  const d = valid(),
    b = draftBody(d);
  assert.equal(b.expectedEffectiveTermsId, base.id);
  assert.equal(b.expectedEffectiveRevision, 1);
  assert.equal(b.terms.milestones[0].id, base.milestones[0].id);
  assert.equal(b.terms.milestones[0].acceptanceCriteria, null);
  assert.equal(
    draftBody({ ...d, proposalRevision: 3 }).expectedProposalRevision,
    3,
  );
});
test("allocation, dates, stages and complete encoded request limits are checked", () => {
  let d = valid();
  d.reward = "11";
  assert.throws(() => draftBody(d), /equal/);
  d = valid();
  d.dueDate = "2027-02-30";
  assert.throws(() => draftBody(d));
  d = valid();
  d.stages = [];
  assert.throws(() => draftBody(d), /1 and 20/);
  d = valid();
  d.description = "漢".repeat(10000);
  d.reason = "漢".repeat(10000);
  d.stages[0].deliverable = "漢".repeat(10000);
  assert.throws(() => draftBody(d), /64 KiB/);
});
test("retirement is explicit and added stage uses client reference", () => {
  const d = valid();
  d.stages[0].retired = true;
  d.stages.push({
    clientReference: "future",
    title: "Future",
    amount: "10.00",
    deliverable: "New report",
    acceptanceCriteria: "",
    retired: false,
  });
  const b = draftBody(d);
  assert.deepEqual(b.terms.retireMilestoneIds, [base.milestones[0].id]);
  assert.equal(b.terms.milestones[0].clientReference, "future");
  assert.equal(b.terms.milestones[0].id, undefined);
});
const notifications = fs.readFileSync(
  "src/components/shared/notification-types.ts",
  "utf8",
);
fs.writeFileSync(
  path.join(temp, "notifications.mjs"),
  ts.transpile(notifications, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  }),
);
const { notificationHref } = await import(path.join(temp, "notifications.mjs"));
test("amendment notification targets the exact revision and unavailable has no link", () => {
  const n = {
    targetAvailable: true,
    target: { type: "agreement", id: base.agreementId },
    navigationAnchor: {
      type: "amendment",
      agreementId: base.agreementId,
      amendmentId: base.id,
      proposalRevision: 3,
    },
  };
  assert.match(
    notificationHref(n),
    new RegExp(
      `amendmentId=${base.id}&proposalRevision=3#amendment-${base.id}-revision-3$`,
    ),
  );
  assert.equal(notificationHref({ ...n, targetAvailable: false }), null);
});
test.after(() => fs.rmSync(temp, { recursive: true }));
const receiptSource = fs.readFileSync(
  "src/components/shared/amendment-receipt.ts",
  "utf8",
);
fs.writeFileSync(
  path.join(temp, "receipt.mjs"),
  ts.transpile(receiptSource, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  }),
);
const { verifyAmendmentReceipt } = await import(path.join(temp, "receipt.mjs"));
test("receipt validation binds operation, resource, revision, terms and confirming account independently of newer projection", () => {
  const pending = {
    account: "actor",
    agreement: base.agreementId,
    proposal: base.id,
    operation: "confirm",
    body: {
      expectedProposalRevision: 2,
      proposedTermsId: base.milestones[0].id,
      proposedTermsRevision: 3,
    },
  };
  const r = {
    agreement: { id: base.agreementId, state: "awaiting_funding" },
    effectiveTerms: { id: base.id, revision: 9 },
    amendment: { id: base.id, proposalRevision: 5, status: "pending" },
    receipt: {
      operation: "confirm",
      agreementId: base.agreementId,
      amendmentId: base.id,
      proposalRevision: 2,
      termsId: base.milestones[0].id,
      termsRevision: 3,
      eventId: base.id,
      outcomeAtCommit: "pending",
      confirmation: {
        userId: "actor",
        amendmentId: base.id,
        proposalRevision: 2,
      },
    },
  };
  assert.doesNotThrow(() => verifyAmendmentReceipt(r, pending));
  for (const [field, value] of [
    ["operation", "withdraw"],
    ["agreementId", base.id],
    ["proposalRevision", 5],
    ["termsId", base.id],
    ["outcomeAtCommit", undefined],
    ["eventId", "malformed"],
  ])
    assert.throws(() =>
      verifyAmendmentReceipt(
        { ...r, receipt: { ...r.receipt, [field]: value } },
        pending,
      ),
    );
  assert.throws(() =>
    verifyAmendmentReceipt(
      {
        ...r,
        receipt: {
          ...r.receipt,
          confirmation: { ...r.receipt.confirmation, userId: "other" },
        },
      },
      pending,
    ),
  );
});
