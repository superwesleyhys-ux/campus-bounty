import test from "node:test";
import assert from "node:assert/strict";
import {
  isolated,
  scenario,
  draft,
  consent,
  key,
  evidence,
} from "./agreement-amendments-fixture.mjs";
const code = (c) => (e) => e.code === c;
const f = await isolated();
const m = f.market;
test.after(() => f.close());
async function proposal(
  s,
  edit = (d) => {
    d.terms.dueDate = "2027-03-15";
  },
  author = s.B ?? s.A,
) {
  const g = await m.agreement(s.P, s.agreement.id),
    d = draft(g);
  edit(d);
  const result = await m.proposeAmendment(author, g.id, d, key());
  return {
    result,
    d,
    detail: await m.agreementAmendment(s.P, g.id, result.amendment.id),
  };
}
async function unanimous(s, p) {
  let result;
  for (const actor of [s.P, s.A, s.B].filter(Boolean))
    result = await m.confirmAmendment(
      actor,
      s.agreement.id,
      p.id,
      consent(p),
      key(),
    );
  return result;
}
const submit = (g, stage, content = "R13 submitted evidence") => ({
  content,
  expectedVersion: stage.version,
  expectedRevision: stage.revision,
  expectedEffectiveTermsId: g.effectiveTerms.id,
  expectedEffectiveRevision: g.effectiveTerms.revision,
});
const review = (r) => ({
  submissionId: r.submission.id,
  expectedVersion: r.milestone.version,
  expectedRevision: r.milestone.revision,
  submissionTermsId: r.submission.submissionTermsId,
  submissionTermsRevision: r.submission.submissionTermsRevision,
});

test("disabled017 preserves both acceptance paths, explicit T1 initialization and private capabilities", async () => {
  for (const versioned of [false, true]) {
    const s = await scenario(f, { versioned, team: true });
    const g = s.agreement;
    assert.equal(g.originalTerms.revision, 1);
    assert.equal(g.originalTerms.id, g.effectiveTerms.id);
    assert.equal(g.originalTerms.origin, "accepted_application");
    assert.equal(g.originalTerms.sourceListingVersion, 1);
    assert.deepEqual(g.terms, g.originalTerms.terms);
    assert.equal(g.effectiveTerms.milestones.length, 2);
    assert.equal(g.agreementAmendments, false);
    assert.deepEqual(await m.capabilities(s.P), {
      agreementAmendments: false,
      agreementTermsBinding: "legacy",
      schemaRequirement: 17,
    });
    const again = await m.acceptInvitation(s.A, s.app.id, {}, key());
    assert.equal(again.id, g.id);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.agreement_terms WHERE agreement_id=$1",
          [g.id],
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      m.proposeAmendment(
        s.A,
        g.id,
        { ...draft(g), terms: { ...draft(g).terms, dueDate: "2027-03-15" } },
        key(),
      ),
      code("agreement_amendments_unavailable"),
    );
    await assert.rejects(m.agreementTerms(s.O, g.id), code("not_found"));
  }
  await f.enable();
});
test("P A B explicit consent, original immutability, revision reset, receipts and notification uniqueness", async () => {
  const s = await scenario(f, { team: true });
  const { result, d, detail: p } = await proposal(s);
  assert.ok(p.participants.every((x) => x.confirmation === null));
  assert.equal(p.participants.length, 3);
  assert.equal(p.proposerId, s.B);
  await assert.rejects(
    m.confirmAmendment(s.O, s.agreement.id, p.id, consent(p), key()),
    code("not_found"),
  );
  await assert.rejects(
    m.confirmAmendment(
      s.A,
      s.agreement.id,
      p.id,
      { ...consent(p), actorId: s.B },
      key(),
    ),
    code("invalid_input"),
  );
  const k = key(),
    a = await m.confirmAmendment(s.A, s.agreement.id, p.id, consent(p), k);
  const count = async () =>
    Number(
      (
        await f.owner.query(
          "SELECT count(*) n FROM campus.agreement_amendment_events WHERE amendment_id=$1",
          [p.id],
        )
      ).rows[0].n,
    );
  const before = await count();
  const duplicate = await m.confirmAmendment(
    s.A,
    s.agreement.id,
    p.id,
    consent(p),
    key(),
  );
  assert.deepEqual(duplicate.receipt, a.receipt);
  assert.equal(await count(), before);
  const revise = {
    ...d,
    expectedProposalRevision: 1,
    terms: { ...d.terms, dueDate: "2027-03-20" },
  };
  const updated = await m.reviseAmendment(
    s.B,
    s.agreement.id,
    p.id,
    revise,
    key(),
  );
  const p2 = await m.agreementAmendment(s.P, s.agreement.id, p.id);
  assert.equal(p2.proposalRevision, 2);
  assert.ok(p2.participants.every((x) => !x.confirmation));
  const old = await m.agreementAmendment(s.P, s.agreement.id, p.id, {
    proposalRevision: "1",
  });
  assert.ok(old.participants.find((x) => x.userId === s.A).confirmation);
  const recovered = await m.confirmAmendment(
    s.A,
    s.agreement.id,
    p.id,
    consent(p),
    k,
  );
  assert.deepEqual(recovered.receipt, a.receipt);
  assert.equal(recovered.amendment.proposalRevision, 2);
  await assert.rejects(
    m.confirmAmendment(s.A, s.agreement.id, p.id, { ...consent(p2) }, k),
    code("idempotency_conflict"),
  );
  const final = await unanimous(s, p2);
  assert.equal(final.amendment.status, "effective");
  assert.equal(final.agreement.state, "awaiting_funding");
  const g = await m.agreement(s.P, s.agreement.id);
  assert.deepEqual(g.terms, s.agreement.terms);
  assert.deepEqual(
    g.milestones.map((x) => [
      x.title,
      x.amount_cents,
      x.deliverable,
      x.acceptance_criteria,
    ]),
    s.agreement.milestones.map((x) => [
      x.title,
      x.amount_cents,
      x.deliverable,
      x.acceptance_criteria,
    ]),
  );
  assert.equal(g.effectiveTerms.terms.dueDate, "2027-03-20");
  await assert.rejects(
    m.submitMilestone(
      s.A,
      g.milestones[0].id,
      submit(g, g.milestones[0]),
      key(),
    ),
    code("funding_required"),
  );
  const events = await m.amendmentEvents(s.P, g.id, p.id, { limit: "50" });
  assert.equal(
    new Set(events.items.map((x) => x.id)).size,
    events.items.length,
  );
  const notifications = await m.notifications(s.P, { limit: "50" });
  assert.ok(
    notifications.items.some((x) => x.amendmentContext?.amendmentId === p.id),
  );
});
test("ordinary concurrent proposal, proposer-only revision/withdraw, rejection and immutable proposal cursor", async () => {
  const s = await scenario(f, { team: true });
  const d = draft(s.agreement);
  d.terms.dueDate = "2027-05-01";
  const race = await Promise.allSettled([
    m.proposeAmendment(s.A, s.agreement.id, d, key()),
    m.proposeAmendment(s.B, s.agreement.id, d, key()),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    race.find((x) => x.status === "rejected").reason.code,
    "live_amendment_exists",
  );
  const id = race.find((x) => x.status === "fulfilled").value.amendment.id;
  let p = await m.agreementAmendment(s.P, s.agreement.id, id);
  const other = p.proposerId === s.A ? s.B : s.A;
  await assert.rejects(
    m.reviseAmendment(
      other,
      s.agreement.id,
      id,
      { ...d, expectedProposalRevision: 1 },
      key(),
    ),
    code("not_proposer"),
  );
  await assert.rejects(
    m.withdrawAmendment(
      other,
      s.agreement.id,
      id,
      { ...consent(p), reason: "Not mine" },
      key(),
    ),
    code("not_proposer"),
  );
  await m.reviseAmendment(
    p.proposerId,
    s.agreement.id,
    id,
    {
      ...d,
      expectedProposalRevision: 1,
      terms: { ...d.terms, dueDate: "2027-06-01" },
    },
    key(),
  );
  p = await m.agreementAmendment(s.P, s.agreement.id, id);
  await m.rejectAmendment(
    other,
    s.agreement.id,
    id,
    { ...consent(p), reason: "Need another plan" },
    key(),
  );
  const second = await proposal(s);
  await m.withdrawAmendment(
    s.B,
    s.agreement.id,
    second.detail.id,
    { ...consent(second.detail), reason: "Withdraw" },
    key(),
  );
  const third = await proposal(s);
  const page = await m.agreementAmendments(s.P, s.agreement.id, { limit: "1" });
  assert.equal(page.items[0].id, third.detail.id);
  const page2 = await m.agreementAmendments(s.P, s.agreement.id, {
    limit: "1",
    cursor: page.nextCursor,
  });
  assert.equal(page2.items[0].id, second.detail.id);
  const page3 = await m.agreementAmendments(s.P, s.agreement.id, {
    limit: "1",
    cursor: page2.nextCursor,
  });
  assert.equal(page3.items[0].id, id);
  assert.equal(page3.items[0].proposalRevision, 2);
  await assert.rejects(
    m.agreementAmendments(s.A, s.agreement.id, { cursor: page.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    m.agreementTerms(s.P, s.agreement.id, { cursor: page.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    m.amendmentEvents(s.P, s.agreement.id, id, { cursor: page.nextCursor }),
    code("invalid_input"),
  );
});
test("historical M1 review stays T1 while future M2 binds T2, protected started scope and exact SQL binding", async () => {
  const s = await scenario(f, { team: true, active: true });
  let g = s.agreement;
  const s1 = await m.submitMilestone(
    s.A,
    g.milestones[0].id,
    submit(g, g.milestones[0]),
    key(),
  );
  const p = await proposal(s, (d) => {
    d.terms.milestones[1].acceptanceCriteria = "New future criteria";
    d.terms.dueDate = "2027-03-15";
  });
  await unanimous(s, p.detail);
  g = await m.agreement(s.P, g.id);
  assert.notEqual(g.effectiveTerms.id, s1.submission.submissionTermsId);
  await assert.rejects(
    m.acceptMilestone(
      s.P,
      g.milestones[0].id,
      {
        ...review(s1),
        submissionTermsId: g.effectiveTerms.id,
        submissionTermsRevision: g.effectiveTerms.revision,
      },
      key(),
    ),
    code("stale_effective_revision"),
  );
  const accepted = await m.acceptMilestone(
    s.P,
    g.milestones[0].id,
    review(s1),
    key(),
  );
  assert.equal(accepted.submission.milestoneTerms.amountCents, 400);
  assert.equal(accepted.submission.submissionTermsRevision, 1);
  await assert.rejects(
    proposal(s, (d) => {
      d.terms.milestones[0].deliverable = "Retroactive rewrite";
    }),
    code("protected_milestone"),
  );
  const s2 = await m.submitMilestone(
    s.B,
    g.milestones[1].id,
    submit(g, g.milestones[1]),
    key(),
  );
  assert.equal(s2.submission.submissionTermsId, g.effectiveTerms.id);
  assert.equal(
    s2.submission.milestoneTerms.acceptanceCriteria,
    "New future criteria",
  );
  const done = await m.acceptMilestone(
    s.P,
    g.milestones[1].id,
    review(s2),
    key(),
  );
  assert.equal(done.agreement.state, "completed");
  await assert.rejects(proposal(s), code("agreement_closed"));
  const h = await m.milestoneReviews(s.P, g.milestones[0].id);
  assert.equal(h[0].submission.submissionTermsRevision, 1);
});
test("changed-stage submission invalidates pending proposal and final acceptance invalidates pending addition", async () => {
  const s = await scenario(f, { team: true, active: true });
  let g = s.agreement;
  const p = await proposal(s, (d) => {
    d.terms.milestones[1].deliverable = "Future changed deliverable";
  });
  const sub = await m.submitMilestone(
    s.A,
    g.milestones[1].id,
    submit(g, g.milestones[1]),
    key(),
  );
  assert.equal(
    (await m.agreementAmendment(s.P, g.id, p.detail.id)).status,
    "stale_work",
  );
  await assert.rejects(
    m.confirmAmendment(s.P, g.id, p.detail.id, consent(p.detail), key()),
    code("invalid_state"),
  );
  const addition = await proposal(s, (d) => {
    d.terms.milestones.push({
      clientReference: "followup",
      title: "M3",
      amountCents: 200,
      deliverable: "Followup",
      acceptanceCriteria: null,
    });
    d.terms.rewardCents += 200;
  });
  const reserved = addition.result.receipt.newMilestoneIds[0];
  await assert.rejects(
    m.submitMilestone(
      s.A,
      reserved.id,
      { ...submit(g, g.milestones[0]) },
      key(),
    ),
    code("not_found"),
  );
  const s1 = await m.submitMilestone(
    s.A,
    g.milestones[0].id,
    submit(g, g.milestones[0]),
    key(),
  );
  await m.acceptMilestone(s.P, g.milestones[0].id, review(s1), key());
  const done = await m.acceptMilestone(
    s.P,
    g.milestones[1].id,
    review(sub),
    key(),
  );
  assert.equal(done.agreement.state, "completed");
  assert.equal(
    (await m.agreementAmendment(s.P, g.id, addition.detail.id)).status,
    "stale_agreement",
  );
  assert.equal((await m.agreement(s.P, g.id)).milestone_counts.total, 2);
});
test("awaiting/active increase decrease reallocation add retirement remain unfunded; reserved identities cannot escape proposal", async () => {
  for (const active of [false, true])
    for (const kind of [
      "increase",
      "decrease",
      "reallocation",
      "add",
      "retire",
    ]) {
      const s = await scenario(f, { active, team: true });
      const g = s.agreement;
      const p = await proposal(s, (d) => {
        if (kind === "increase") {
          d.terms.rewardCents += 100;
          d.terms.milestones[1].amountCents += 100;
        }
        if (kind === "decrease") {
          d.terms.rewardCents -= 100;
          d.terms.milestones[1].amountCents -= 100;
        }
        if (kind === "reallocation") {
          d.terms.milestones[0].amountCents += 100;
          d.terms.milestones[1].amountCents -= 100;
        }
        if (kind === "add") {
          d.terms.rewardCents += 100;
          d.terms.milestones.push({
            clientReference: "extra",
            title: "Extra",
            amountCents: 100,
            deliverable: "Report",
            acceptanceCriteria: null,
          });
        }
        if (kind === "retire") {
          const r = d.terms.milestones.pop();
          d.terms.retireMilestoneIds = [r.id];
          d.terms.rewardCents -= r.amountCents;
        }
      });
      const result = await unanimous(s, p.detail);
      assert.equal(result.amendment.status, "agreed_waiting_funds");
      assert.equal(result.effectiveTerms.id, g.effectiveTerms.id);
      assert.equal(result.agreement.state, g.state);
      assert.equal(result.funding.additionalFundingCents, null);
      assert.equal(result.funding.refundCents, null);
      assert.equal(result.funding.canExecutePayment, false);
      assert.equal(result.funding.requirement, "funding_reconciliation");
      await f.owner.query("SELECT campus.validate_amendment_effect($1,1)", [
        p.detail.id,
      ]);
      if (active) {
        const work = await m.submitMilestone(
          s.A,
          g.milestones[0].id,
          submit(g, g.milestones[0]),
          key(),
        );
        assert.equal(work.submission.submissionTermsId, g.effectiveTerms.id);
      }
      if (kind === "add") {
        const reserved = p.result.receipt.newMilestoneIds[0];
        await m.withdrawAmendment(
          s.B,
          g.id,
          p.detail.id,
          { ...consent(p.detail), reason: "New proposal needed" },
          key(),
        );
        await assert.rejects(
          proposal(s, (d) => {
            d.terms.rewardCents += 100;
            d.terms.milestones.push({
              id: reserved.id,
              position: reserved.position,
              title: "Reuse",
              amountCents: 100,
              deliverable: "No",
              acceptanceCriteria: null,
            });
          }),
          code("invalid_milestone_set"),
        );
      }
    }
});
test("app direct DML/private helper bypass denied, cross-agreement identity rejected, settings latch holds", async () => {
  const s = await scenario(f, { active: true });
  const g = s.agreement;
  for (const sql of [
    "UPDATE campus.agreement_terms_state SET effective_revision=1",
    "DELETE FROM campus.agreement_terms",
    "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false",
    "SELECT * FROM campus.schema_migrations",
    "SELECT * FROM campus.agreement_amendment_settings",
    "SELECT campus.initialize_agreement_terms($1,'accepted_application')",
    "SELECT campus.validate_amendment_effect($1,1)",
    "SELECT campus.accepted_listing_source($1)",
    "SELECT campus.agreement_matches_listing(null,null)",
  ])
    await assert.rejects(
      f.store.as(s.A, (c) => c.query(sql, sql.includes("$1") ? [g.id] : [])),
      (e) => e.code === "42501",
    );
  await assert.rejects(
    f.store.as(s.A, (c) =>
      c.query("SELECT campus.submit_milestone_work($1,0,1,$2)", [
        g.milestones[0].id,
        "Bypass",
      ]),
    ),
    (e) => e.message === "terms_refresh_required",
  );
  const other = await scenario(f);
  await assert.rejects(
    proposal(s, (d) => {
      d.terms.milestones[0] = {
        ...d.terms.milestones[0],
        id: other.agreement.milestones[0].id,
      };
    }),
    code("invalid_milestone_set"),
  );
  await f.owner.query(
    "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false WHERE singleton",
  );
  assert.equal((await m.capabilities(s.P)).agreementTermsBinding, "explicit");
  await assert.rejects(
    m.submitMilestone(
      s.A,
      g.milestones[0].id,
      { content: "Missing binding", expectedVersion: 0, expectedRevision: 1 },
      key(),
    ),
    code("terms_refresh_required"),
  );
  assert.equal((await m.agreementTerms(s.P, g.id)).items.length, 1);
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.agreement_amendment_settings SET strict_binding=false WHERE singleton",
    ),
    (e) => e.code === "23514",
  );
  await f.enable();
});

test("resubmission and exact historical revision-request preserve scope; current authority is rechecked on ordinary replay", async () => {
  const s = await scenario(f, { active: true, team: true });
  const g = s.agreement;
  const first = await m.submitMilestone(
    s.A,
    g.milestones[0].id,
    submit(g, g.milestones[0]),
    key(),
  );
  const p = await proposal(s, (d) => {
    d.terms.milestones[1].deliverable = "Future scope";
    d.terms.dueDate = "2027-04-01";
  });
  await unanimous(s, p.detail);
  const changes = await m.requestMilestoneRevision(
    s.P,
    g.milestones[0].id,
    { ...review(first), feedback: "Add sources under original criteria" },
    key(),
  );
  assert.equal(changes.submission.submissionTermsRevision, 1);
  const current = await m.agreement(s.P, g.id);
  const second = await m.submitMilestone(
    s.A,
    g.milestones[0].id,
    submit(current, changes.milestone, "Revised sources"),
    key(),
  );
  assert.equal(second.submission.submissionTermsId, current.effectiveTerms.id);
  assert.deepEqual(
    second.submission.milestoneTerms,
    first.submission.milestoneTerms,
  );
  const history = await m.submissions(s.P, g.milestones[0].id);
  assert.deepEqual(
    history.map((x) => x.submissionTermsRevision),
    [1, current.effectiveTerms.revision],
  );
  const next = await proposal(s);
  const k = key();
  const done = await m.confirmAmendment(
    s.P,
    g.id,
    next.detail.id,
    consent(next.detail),
    k,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [s.P],
  );
  await assert.rejects(
    m.confirmAmendment(s.P, g.id, next.detail.id, consent(next.detail), k),
    code("account_restricted"),
  );
  assert.equal(
    (await m.agreementAmendment(s.P, g.id, next.detail.id)).id,
    next.detail.id,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='active' WHERE id=$1",
    [s.P],
  );
  assert.deepEqual(
    (
      await m.confirmAmendment(
        s.P,
        g.id,
        next.detail.id,
        consent(next.detail),
        k,
      )
    ).receipt,
    done.receipt,
  );
});
test("strict validation, retire protection, reserved revision reuse and actor/resource/event pagination boundaries", async () => {
  const s = await scenario(f, { active: true, team: true }),
    g = s.agreement;
  await assert.rejects(
    m.proposeAmendment(s.A, g.id, draft(g), key()),
    code("no_change"),
  );
  for (const edit of [
    (d) => {
      d.terms.rewardCents++;
    },
    (d) => {
      d.terms.milestones.pop();
      d.terms.rewardCents = 400;
    },
    (d) => {
      d.terms.milestones[1].id = d.terms.milestones[0].id;
    },
    (d) => {
      d.terms.milestones[0].position = 9;
    },
  ])
    await assert.rejects(proposal(s, edit), (e) =>
      ["invalid_milestone_budget", "invalid_milestone_set"].includes(e.code),
    );
  for (const edit of [
    (d) => {
      d.terms.dueDate = "2027-02-29";
    },
    (d) => {
      d.terms.currency = "EUR";
    },
    (d) => {
      d.terms.members = [s.O];
    },
    (d) => {
      d.terms.milestones[0].title = "";
    },
    (d) => {
      d.reason = "";
    },
  ])
    await assert.rejects(proposal(s, edit), code("invalid_input"));
  const p = await proposal(s, (d) => {
    d.terms.rewardCents += 100;
    d.terms.milestones.push({
      clientReference: "new",
      title: "New",
      amountCents: 100,
      deliverable: "New work",
      acceptanceCriteria: null,
    });
  });
  const edit = {
    ...p.d,
    expectedProposalRevision: 1,
    terms: {
      ...p.d.terms,
      milestones: p.detail.proposedTerms.milestones,
      dueDate: "2027-06-01",
    },
  };
  const revised = await m.reviseAmendment(s.B, g.id, p.detail.id, edit, key());
  assert.deepEqual(revised.receipt.newMilestoneIds, []);
  assert.equal(
    (await m.agreementAmendment(s.P, g.id, p.detail.id)).proposedTerms
      .milestones[2].id,
    p.result.receipt.newMilestoneIds[0].id,
  );
  const first = await m.amendmentEvents(s.P, g.id, p.detail.id, { limit: "1" });
  assert.ok(first.nextCursor);
  const last = await m.amendmentEvents(s.P, g.id, p.detail.id, {
    limit: "1",
    cursor: first.nextCursor,
  });
  assert.notEqual(last.items[0].sequence, first.items[0].sequence);
  const other = await scenario(f);
  await assert.rejects(
    m.amendmentEvents(s.P, other.agreement.id, p.detail.id, {
      cursor: first.nextCursor,
    }),
    code("invalid_input"),
  );
  await assert.rejects(
    m.amendmentEvents(s.A, g.id, p.detail.id, { cursor: first.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    m.amendmentEvents(s.P, g.id, key(), { cursor: first.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    m.amendmentEvents(s.P, g.id, p.detail.id, {
      cursor: first.nextCursor + "=",
    }),
    code("invalid_input"),
  );
  const detail = await m.agreementAmendment(s.P, g.id, p.detail.id);
  await m.withdrawAmendment(
    s.B,
    g.id,
    p.detail.id,
    { ...consent(detail), reason: "Retirement validation" },
    key(),
  );
  const retire = await proposal(s, (d) => {
    const retired = d.terms.milestones.pop();
    d.terms.retireMilestoneIds = [retired.id];
    d.terms.rewardCents -= retired.amountCents;
  });
  await m.submitMilestone(
    s.A,
    g.milestones[1].id,
    submit(g, g.milestones[1]),
    key(),
  );
  assert.equal(
    (await m.agreementAmendment(s.P, g.id, retire.detail.id)).status,
    "stale_work",
  );
  await assert.rejects(
    proposal(s, (d) => {
      const retired = d.terms.milestones.pop();
      d.terms.retireMilestoneIds = [retired.id];
      d.terms.rewardCents -= retired.amountCents;
    }),
    code("protected_milestone"),
  );
  const constraints = (
    await f.owner.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='campus.submission_terms'::regclass AND contype='f'",
    )
  ).rows
    .map((x) => x.definition)
    .join("\n");
  assert.match(constraints, /milestone_id, agreement_id/);
  assert.match(constraints, /terms_id, agreement_id, terms_revision/);
  assert.match(constraints, /submission_id, milestone_id, submission_version/);
});
test("concrete exported DTO samples and finite history pages match real service responses", async () => {
  const { writeFile } = await import("node:fs/promises");
  const s = await scenario(f, { active: true, team: true });
  const g = s.agreement;
  const p = await proposal(s);
  const result = await unanimous(s, p.detail);
  const current = await m.agreement(s.P, g.id);
  const work = await m.submitMilestone(
    s.A,
    current.milestones[0].id,
    submit(current, current.milestones[0]),
    key(),
  );
  const accepted = await m.acceptMilestone(
    s.P,
    current.milestones[0].id,
    review(work),
    key(),
  );
  const terms = await m.agreementTerms(s.P, g.id, { limit: "1" });
  assert.ok(terms.nextCursor);
  const older = await m.agreementTerms(s.P, g.id, {
    limit: "1",
    cursor: terms.nextCursor,
  });
  assert.notEqual(older.items[0].id, terms.items[0].id);
  const notification = (await m.notifications(s.P, { limit: "50" })).items.find(
    (x) => x.amendmentContext?.amendmentId === p.detail.id,
  );
  assert.ok(notification);
  assert.equal(notification.amendmentContext.proposalRevision, 1);
  assert.equal(notification.navigationAnchor.type, "amendment");
  const samples = {
    AgreementCapabilities: await m.capabilities(s.P),
    AgreementDetail: await m.agreement(s.P, g.id),
    AgreementTerms: current.effectiveTerms,
    AgreementTermsPage: terms,
    AgreementAmendmentsPage: await m.agreementAmendments(s.P, g.id),
    AgreementAmendment: await m.agreementAmendment(s.P, g.id, p.detail.id),
    AmendmentEventsPage: await m.amendmentEvents(s.P, g.id, p.detail.id),
    AmendmentCommandResult: result,
    FulfillmentResult: accepted,
    AgreementSubmission: work.submission,
    MilestoneReview: (
      await m.milestoneReviews(s.P, current.milestones[0].id)
    )[0],
    Notification: notification,
  };
  await writeFile(
    new URL("dto-samples-" + f.database + ".json", evidence),
    JSON.stringify(samples, null, 2),
  );
});

test("apply v1 then accept v2 preserves original/current/candidate source for both acceptance paths and permitted peer labels", async () => {
  for (const versioned of [false, true]) {
    const s = await scenario(f, {
      versioned,
      team: true,
      editedBeforeAcceptance: true,
    });
    const g = s.agreement;
    for (const terms of [g.originalTerms, g.effectiveTerms]) {
      assert.equal(terms.sourceListingVersion, 2);
      assert.equal(terms.terms.taskTitle, "R13 accepted v2");
      assert.equal(terms.terms.description, "Accepted revised description");
      assert.equal(terms.terms.dueDate, "2027-03-02");
      assert.deepEqual(terms.terms, g.terms);
    }
    assert.equal(
      (
        await f.owner.query(
          "SELECT submitted_version FROM campus.application_listing_terms WHERE application_id=$1",
          [s.app.id],
        )
      ).rows[0].submitted_version,
      1,
    );
    const p = await proposal(s);
    assert.equal(p.detail.proposedTerms.sourceListingVersion, 2);
    const expected = new Map([
      [s.P, "R13 P"],
      [s.A, "R13 A"],
      [s.B, "R13 B"],
    ]);
    for (const actor of [s.P, s.B]) {
      const detail = await m.agreementAmendment(actor, g.id, p.detail.id);
      assert.equal(detail.participants.length, 3);
      for (const person of detail.participants)
        assert.equal(person.displayName, expected.get(person.userId));
    }
    await assert.rejects(
      m.agreementAmendment(s.O, g.id, p.detail.id),
      code("not_found"),
    );
  }
});

test("pure legacy validator rejects null/missing/wrong mandatory scalars without modifying business rows", async () => {
  const s = await scenario(f, { team: true });
  const r = (
    await f.owner.query(
      `SELECT g.terms,g.captain_id,g.owner_id,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY position) FROM campus.milestones m WHERE agreement_id=g.id) AS stages,
    (SELECT array_agg(user_id ORDER BY user_id) FROM campus.agreement_members WHERE agreement_id=g.id) AS members
    FROM campus.agreements g WHERE g.id=$1`,
      [s.agreement.id],
    )
  ).rows[0];
  const validate = async (
    terms,
    stages = r.stages,
    members = r.members,
    captain = r.captain_id,
    owner = r.owner_id,
  ) =>
    (
      await f.owner.query(
        "SELECT campus.validate_legacy_agreement_snapshot($1::jsonb,$2::jsonb,$3::uuid[],$4::uuid,$5::uuid) AS valid",
        [
          JSON.stringify(terms),
          JSON.stringify(stages),
          members,
          captain,
          owner,
        ],
      )
    ).rows[0].valid;
  assert.equal(await validate(r.terms), true);
  for (const field of [
    "currency",
    "taskTitle",
    "description",
    "rewardCents",
    "members",
    "milestones",
  ]) {
    const missing = structuredClone(r.terms);
    delete missing[field];
    assert.equal(await validate(missing), false, field + " absent");
    for (const value of [null, {}, true])
      assert.equal(
        await validate({ ...r.terms, [field]: value }),
        false,
        field + " " + JSON.stringify(value),
      );
  }
  for (const currency of ["EUR", "", 840, ["USD"]])
    assert.equal(await validate({ ...r.terms, currency }), false);
  for (const terms of [null, {}, []])
    assert.equal(await validate(terms), false);
  assert.equal(await validate(r.terms, null), false);
  assert.equal(await validate(r.terms, r.stages, r.members, null), false);
  assert.equal(
    await validate(r.terms, r.stages, r.members, r.captain_id, null),
    false,
  );
  for (const field of ["position", "title", "amount_cents", "deliverable"]) {
    const terms = structuredClone(r.terms),
      stages = structuredClone(r.stages);
    terms.milestones[0][field] = stages[0][field] = null;
    assert.equal(await validate(terms, stages), false, "stage " + field);
  }
  const optionalLegacy = structuredClone(r.terms),
    stages = structuredClone(r.stages);
  delete optionalLegacy.dueDate;
  optionalLegacy.milestones.forEach((x) => {
    delete x.acceptance_criteria;
  });
  stages.forEach((x) => {
    x.acceptance_criteria = null;
  });
  assert.equal(await validate(optionalLegacy, stages), true);
});
