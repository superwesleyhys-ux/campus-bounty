// Runs only inside the controller-released owned Task3 fix1 harness. Never stores sessions or OTPs.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const key = randomUUID;
const btn = (p, name) => p.getByRole("button", { name, exact: true });
const consent = (p) => ({
  expectedEffectiveTermsId: p.baseTerms.id,
  expectedEffectiveRevision: p.baseTerms.revision,
  expectedProposalRevision: p.proposalRevision,
  proposedTermsId: p.proposedTerms.id,
  proposedTermsRevision: p.proposedTerms.revision,
});
function record(e, check, data = {}) {
  e.checks.push({
    at: new Date().toISOString(),
    environment: e.release.origin,
    database: e.release.database,
    check,
    ...data,
  });
}
const href = (e, g) =>
  `${e.release.origin}/?view=workspace&tab=agreements&resource=agreement&id=${g}`;
async function open(e, role, g) {
  const p = e.pages[role];
  await p.goto(href(e, g));
  await p
    .getByRole("heading", { name: /Current terms|Changes and history/ })
    .first()
    .waitFor();
  await btn(p, "Refresh changes").waitFor();
  return p;
}
async function login(e, role, page) {
  await page.goto(e.release.origin);
  await page
    .getByLabel("University email", { exact: true })
    .fill(e.release.recipients[role]);
  const started = Date.now();
  await btn(page, "Email me a sign-in code").click();
  await page.getByLabel("Sign-in code", { exact: true }).waitFor();
  const file = path.join(
    e.folder,
    e.release.recipients[role].split("@")[0] + ".txt",
  );
  let code,
    ticks = 0;
  for (; ticks < 100; ticks++) {
    await e.worker.tick();
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= started)
      code = fs
        .readFileSync(file, "utf8")
        .match(/verification code is (\d{6})/)?.[1];
    if (code) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, "private synthetic code delivered");
  await page.getByLabel("Sign-in code", { exact: true }).fill(code);
  await page.getByLabel("Your display name").fill(`R13 ${role}`);
  await btn(page, "Verify and continue").click();
  await btn(page, "Sign out").waitFor();
  record(e, "normal email-code sign-in", {
    role,
    sequentialLocalMailTicks: ticks + 1,
    sessionInjected: false,
  });
}
async function createAgreement(e, name) {
  const m = e.market,
    u = e.users;
  let team = e.team;
  if (!team) {
    team = await m.createTeam(
      u.captain,
      {
        name: "R13 amendment collaborators",
        context: {
          purpose: "Read and compare research",
          activities: "Review sources",
          timeCommitment: "One hour",
          projectContext: "Isolated UI engineering",
        },
      },
      key(),
    );
    await m.inviteMember(
      u.captain,
      team.id,
      { userId: u.collaborator, expectedRevision: team.revision },
      key(),
    );
    const t = await m.team(u.collaborator, team.id);
    await m.acceptMembership(
      u.collaborator,
      team.id,
      { expectedRevision: t.revision },
      key(),
    );
    e.team = team;
  }
  const task = await m.publishTask(
    u.publisher,
    {
      title: `R13 ${name}`,
      category: "Research",
      description:
        "R13 original general scope. Preserve old submissions and recorded criteria.",
      rewardCents: 1000,
      dueDate: "2027-03-01",
      milestones: [
        {
          title: "M1 Dataset",
          amountCents: 400,
          deliverable: "Annotated dataset",
          acceptanceCriteria: "Cite the original sources",
        },
        {
          title: "M2 Report",
          amountCents: 600,
          deliverable: "Research report",
          acceptanceCriteria: "Original report analysis",
        },
      ],
    },
    key(),
  );
  const a = await m.apply(
    u.captain,
    task.id,
    { proposal: `R13 ${name} ordinary service setup`, teamId: team.id },
    key(),
  );
  await m.consentApplication(u.collaborator, a.id, {}, key());
  const current = await m.task(u.publisher, task.id);
  for (const who of [u.captain, u.collaborator])
    await m.acknowledgeApplicationTerms(
      who,
      a.id,
      {
        expectedTermsVersion: current.terms_version,
        expectedRevision: current.revision,
      },
      key(),
    );
  await m.inviteApplicationVersion(
    u.publisher,
    a.id,
    {
      expectedTermsVersion: current.terms_version,
      expectedRevision: current.revision,
    },
    key(),
  );
  const accepted = await m.acceptApplicationVersion(
    u.captain,
    a.id,
    {
      expectedTermsVersion: current.terms_version,
      expectedRevision: current.revision,
    },
    key(),
  );
  const g = await m.agreement(u.publisher, accepted.receipt.agreementId);
  record(e, "ordinary-service setup (not browser creation)", {
    name,
    taskId: task.id,
    applicationId: a.id,
    agreementId: g.id,
    memberIds: g.members.map((v) => v.user_id),
    state: g.state,
  });
  return g;
}
async function proposal(e, role, g, edit) {
  const p = await open(e, role, g);
  await btn(p, "Start a new proposal").click();
  await edit(p);
  await btn(p, "Review comparison").click();
  await p.getByRole("dialog").waitFor();
  await btn(p, "Publish proposal").click();
  await p.getByText(/Verified propose receipt/).waitFor();
  const current = await e.market.agreement(e.users[role], g);
  const a = await e.market.agreementAmendment(
    e.users[role],
    g,
    current.amendmentSummary.id,
  );
  return a;
}
async function confirm(e, role, g) {
  const p = await open(e, role, g);
  await p
    .getByRole("checkbox", { name: /I reviewed proposal revision/ })
    .check();
  await btn(p, "Confirm this revision").click();
  await p.getByText(/Verified confirm receipt/).waitFor();
  return e.market.agreement(e.users[role], g);
}
async function end(e, role, g, operation = "Reject proposal") {
  const p = await open(e, role, g);
  await p
    .getByLabel("Reason to reject or withdraw")
    .fill("R13 closing this test proposal with an explicit reason");
  await btn(p, operation).click();
  await p.getByText(/Verified (reject|withdraw) receipt/).waitFor();
}
async function interception(page, pattern, handler) {
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}
async function waitUnknown(p, work = false) {
  await p
    .getByText(
      work
        ? /The outcome is not confirmed|Outcome not confirmed|request outcome is unknown/i
        : "Request outcome not confirmed",
      { exact: !work },
    )
    .first()
    .waitFor();
}
export async function run(e, phase) {
  if (phase === "setup") {
    for (const role of Object.keys(e.users)) {
      const context = await e.browser.newContext({
        viewport: { width: role === "collaborator" ? 390 : 1440, height: 1000 },
      });
      await context.route("**/*", (r) =>
        new URL(r.request().url()).hostname === "127.0.0.1"
          ? r.continue()
          : r.abort(),
      );
      const p = await context.newPage();
      p.setDefaultTimeout(15000);
      e.pages[role] = p;
      await login(e, role, p);
    }
    e.g = await createAgreement(e, "fix1 narrow regression");
    const updated = await e.owner.query(
      "UPDATE campus.agreements SET state='active' WHERE id=$1 AND state='awaiting_funding'",
      [e.g.id],
    );
    assert.equal(updated.rowCount, 1);
    e.journal({
      action: "exact_synthetic_activation",
      agreementId: e.g.id,
      rowCount: 1,
      synthetic_activation: true,
      fundingEvidence: false,
    });
    e.g = await e.market.agreement(e.users.captain, e.g.id);
    assert.equal(e.g.agreementTermsBinding, "legacy");
    assert.equal(
      (
        await e.owner.query(
          "SELECT count(*)::int AS n FROM campus.schema_migrations",
        )
      ).rows[0].n,
      16,
    );
    const p = await open(e, "captain", e.g.id),
      mid = e.g.milestones[0].id;
    await p
      .locator("#milestone-" + mid)
      .getByLabel("Your deliverable", { exact: true })
      .fill("R13 fix1 successful legacy16 submission");
    const handler = async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      e.legacyFrozen = {
        body: r.request().postData(),
        key: r.request().headers()["idempotency-key"],
      };
      const response = await r.fetch();
      e.legacyReceipt = await response.json();
      assert.ok(response.ok());
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{broken",
      });
    };
    const off = await interception(
      p,
      "**/api/v1/milestones/" + mid + "/submissions",
      handler,
    );
    await btn(p.locator("#milestone-" + mid), "Submit for review").click();
    await btn(p.locator("#milestone-" + mid), "Retry same request").waitFor();
    await off();
    const history = await e.market.submissions(e.users.captain, mid);
    assert.equal(history.length, 1);
    assert.equal(
      "expectedEffectiveTermsId" in JSON.parse(e.legacyFrozen.body),
      false,
    );
    record(
      e,
      "actual001-016 ordinary work UI and committed unknown legacy POST",
      {
        agreementId: e.g.id,
        milestoneId: mid,
        migrationCount: 16,
        binding: e.g.agreementTermsBinding,
        receipt: e.legacyReceipt.receipt,
        submission: history[0],
        synthetic_activation: true,
      },
    );
    await p.screenshot({
      path: path.join(e.evidence, "legacy16-unknown-1440.png"),
      fullPage: true,
    });
  }
  if (phase === "cutover") {
    await e.install017();
    let c = await e.market.agreement(e.users.captain, e.g.id);
    assert.equal(c.agreementAmendments, false);
    assert.equal(c.agreementTermsBinding, "legacy");
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true,strict_binding=true WHERE singleton",
    );
    c = await e.market.agreement(e.users.captain, e.g.id);
    assert.equal(c.agreementTermsBinding, "explicit");
    e.journal({
      action: "isolated_strict_activation",
      capability: {
        agreementAmendments: c.agreementAmendments,
        agreementTermsBinding: c.agreementTermsBinding,
      },
    });
    const p = await open(e, "captain", e.g.id),
      mid = e.g.milestones[0].id;
    let seen;
    const h = async (r) => {
      if (r.request().method() === "POST")
        seen = {
          body: r.request().postData(),
          key: r.request().headers()["idempotency-key"],
        };
      await r.continue();
    };
    const off = await interception(
      p,
      "**/api/v1/milestones/" + mid + "/submissions",
      h,
    );
    await btn(p.locator("#milestone-" + mid), "Retry same request").click();
    await p
      .getByText(/Your earlier submission was confirmed/i)
      .first()
      .waitFor();
    await off();
    assert.deepEqual(seen, e.legacyFrozen);
    const rows = await e.market.submissions(e.users.captain, mid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, e.legacyReceipt.receipt.submissionId);
    record(
      e,
      "actual unchanged017 install and current client legacy exact receipt recovery",
      {
        agreementId: e.g.id,
        disabledDefaultsVerified: true,
        strictBinding: c.agreementTermsBinding,
        sameBody: true,
        sameKey: true,
        originalReceipt: e.legacyReceipt.receipt,
        submission: rows[0],
        immutableSubmissionCount: rows.length,
      },
    );
  }
  if (phase === "workrecovery") {
    const g = await e.market.agreement(e.users.captain, e.g.id),
      mid = g.milestones[1].id,
      p = await open(e, "captain", g.id),
      panel = p.locator("#milestone-" + mid);
    await panel
      .getByLabel("Your deliverable", { exact: true })
      .fill("R13 fix1 strict work history verification recovery");
    let posts = [],
      committed = false,
      historyMode = "429",
      identityMode = false;
    const h = async (r) => {
      if (r.request().method() === "POST") {
        posts.push({
          body: r.request().postData(),
          key: r.request().headers()["idempotency-key"],
        });
        const response = await r.fetch();
        committed = true;
        return r.fulfill({ response });
      }
      if (committed && historyMode === "429")
        return r.fulfill({
          status: 429,
          json: { detail: "Owned synthetic history429" },
        });
      if (committed && historyMode === "malformed")
        return r.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      return r.continue();
    };
    const off = await interception(
      p,
      "**/api/v1/milestones/" + mid + "/submissions",
      h,
    );
    await btn(panel, "Submit for review").click();
    await btn(panel, "Retry same request").waitFor();
    const saved = await p.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([k]) => k.startsWith("campus:fulfillment-request:"))
        .map(([k, v]) => [k, JSON.parse(v)]),
    );
    assert.ok(
      saved.some(([, v]) => v.path === `milestones/${mid}/submissions`),
    );
    const me = async (r) =>
      r.fulfill({ status: 429, json: { detail: "Owned identity429" } });
    await p.route("**/api/v1/me", me);
    await btn(panel, "Retry same request").click();
    await panel.getByText("Owned identity429").waitFor();
    assert.equal(posts.length, 1);
    await p.unroute("**/api/v1/me", me);
    historyMode = "malformed";
    await btn(panel, "Retry same request").click();
    await btn(panel, "Retry same request").waitFor();
    assert.equal(posts.length, 2);
    historyMode = "ok";
    await btn(panel, "Retry same request").click();
    await panel
      .getByText(/Your earlier submission was confirmed/i)
      .first()
      .waitFor();
    await off();
    assert.equal(posts.length, 3);
    for (const v of posts) assert.deepEqual(v, posts[0]);
    assert.equal((await e.market.submissions(e.users.captain, mid)).length, 1);
    record(
      e,
      "strict submit POST committed then history429, pending me429, malformed history and exact recovery",
      {
        milestoneId: mid,
        postAttempts: posts.length,
        identity429DidNotReplay: true,
        sameBody: true,
        sameKey: true,
        immutableSubmissionCount: 1,
      },
    );
  }
  if (phase === "reviewrecovery") {
    const p = await open(e, "publisher", e.g.id),
      mid = e.g.milestones[0].id,
      panel = p.locator("#milestone-" + mid);
    let committed = false,
      mode = "429",
      posts = [];
    const post = async (r) => {
      posts.push({
        body: r.request().postData(),
        key: r.request().headers()["idempotency-key"],
      });
      const response = await r.fetch();
      committed = true;
      return r.fulfill({ response });
    };
    const history = async (r) =>
      committed && mode === "429"
        ? r.fulfill({
            status: 429,
            json: { detail: "Owned review history429" },
          })
        : committed && mode === "malformed"
          ? r.fulfill({ status: 200, json: { wrong: "shape" } })
          : r.continue();
    await p.route("**/api/v1/milestones/" + mid + "/acceptance", post);
    await p.route("**/api/v1/milestones/" + mid + "/reviews", history);
    await panel.getByRole("checkbox").check();
    await btn(panel, "Accept version 1").click();
    await btn(panel, "Retry same request").waitFor();
    mode = "malformed";
    await btn(panel, "Retry same request").click();
    await btn(panel, "Retry same request").waitFor();
    mode = "ok";
    await btn(panel, "Retry same request").click();
    await panel
      .getByText(/Your earlier acceptance was confirmed/i)
      .first()
      .waitFor();
    await p.waitForTimeout(250);
    await p.unroute("**/api/v1/milestones/" + mid + "/acceptance", post);
    await p.unroute("**/api/v1/milestones/" + mid + "/reviews", history);
    assert.equal(posts.length, 3);
    for (const v of posts) assert.deepEqual(v, posts[0]);
    const rows = await e.market.milestoneReviews(e.users.publisher, mid);
    assert.equal(rows.length, 1);
    record(
      e,
      "acceptance committed then reviews429 and malformed reviews recover exact intent",
      {
        milestoneId: mid,
        sameBody: true,
        sameKey: true,
        postAttempts: 3,
        reviews: rows,
      },
    );
  }
  if (phase === "amendmentsessions") {
    const p = await open(e, "collaborator", e.g.id);
    await btn(p, "Start a new proposal").click();
    await p
      .getByLabel("Reason for this change")
      .fill("R13 fix1 exact unknown proposal");
    await p.getByLabel("Proposed target date").fill("2027-04-01");
    let posts = [],
      committed = false,
      mode = "429";
    const post = async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      posts.push({
        body: r.request().postData(),
        key: r.request().headers()["idempotency-key"],
      });
      const response = await r.fetch();
      committed = true;
      return r.fulfill({ response });
    };
    const history = async (r) => {
      if (
        r.request().method() === "GET" &&
        committed &&
        new URL(r.request().url()).searchParams.has("proposalRevision")
      ) {
        if (mode === "429")
          return r.fulfill({
            status: 429,
            json: { detail: "Owned exact revision429" },
          });
        if (mode === "malformed")
          return r.fulfill({ status: 200, json: { wrong: "history" } });
      }
      return r.continue();
    };
    await p.route("**/api/v1/agreements/" + e.g.id + "/amendments", post);
    await p.route(
      "**/api/v1/agreements/" + e.g.id + "/amendments/*?*",
      history,
    );
    await btn(p, "Review comparison").click();
    await btn(p, "Publish proposal").click();
    await btn(p, "Recover request").waitFor();
    const me = async (r) =>
      r.fulfill({ status: 429, json: { detail: "Owned pending identity429" } });
    await p.route("**/api/v1/me", me);
    await btn(p, "Recover request").click();
    await p.getByText("Owned pending identity429").waitFor();
    assert.equal(posts.length, 1);
    await p.unroute("**/api/v1/me", me);
    mode = "malformed";
    await btn(p, "Recover request").click();
    await btn(p, "Recover request").waitFor();
    assert.equal(posts.length, 2);
    const current = await e.market.agreement(e.users.collaborator, e.g.id);
    e.amendmentId = current.amendmentSummary.id;
    const sibling = await p.context().newPage();
    await sibling.goto(e.release.origin);
    await btn(sibling, "Sign out").click();
    await sibling.getByLabel("University email", { exact: true }).waitFor();
    await p.getByLabel("University email", { exact: true }).waitFor();
    assert.equal(await btn(p, "Recover request").count(), 0);
    record(e, "ordinary own-session signout clears private unknown view", {
      agreementId: e.g.id,
      sessionLoss: true,
      membershipRevocation: false,
      unknownControlHidden: true,
    });
    await sibling.close();
    await login(e, "outsider", p);
    await p.goto(
      href(e, e.g.id) +
        `&amendmentId=${e.amendmentId}&proposalRevision=1#amendment-${e.amendmentId}-revision-1`,
    );
    await p
      .getByText(/not found|unavailable|not available/i)
      .first()
      .waitFor();
    assert.equal(await btn(p, "Recover request").count(), 0);
    assert.equal(await p.getByLabel("Reason for this change").count(), 0);
    assert.equal(posts.length, 2);
    record(
      e,
      "outsider direct own synthetic notification context denied, pending request not replayed",
      {
        agreementId: e.g.id,
        amendmentId: e.amendmentId,
        requestedRevision: 1,
        noPrivateDraft: true,
        noReplay: true,
      },
    );
    await btn(p, "Sign out").click();
    await login(e, "collaborator", p);
    mode = "ok";
    await open(e, "collaborator", e.g.id);
    await btn(p, "Recover request").click();
    await p.getByText(/Verified propose receipt/).waitFor();
    await p.unroute("**/api/v1/agreements/" + e.g.id + "/amendments", post);
    await p.unroute(
      "**/api/v1/agreements/" + e.g.id + "/amendments/*?*",
      history,
    );
    assert.equal(posts.length, 3);
    for (const x of posts) assert.deepEqual(x, posts[0]);
    const events = await e.market.amendmentEvents(
      e.users.collaborator,
      e.g.id,
      e.amendmentId,
      { limit: "20" },
    );
    assert.equal(
      events.items.filter((x) => x.operation === "propose").length,
      1,
    );
    record(
      e,
      "amendment committed history429/me429/malformed then account switch exact recovery",
      {
        agreementId: e.g.id,
        amendmentId: e.amendmentId,
        postAttempts: 3,
        sameBody: true,
        sameKey: true,
        proposeEvents: 1,
        events: events.items,
      },
    );
  }
  if (phase === "revision") {
    await confirm(e, "captain", e.g.id);
    const first = await open(e, "collaborator", e.g.id);
    await btn(first, "Revise proposal").click();
    await first
      .getByLabel("Reason for this change")
      .fill("R13 fix1 retained stale revision edits");
    await first
      .getByLabel("General scope")
      .fill("R13 fix1 first-session retained scope");
    const publisher = await open(e, "publisher", e.g.id);
    await publisher
      .getByRole("checkbox", { name: /I reviewed proposal revision/ })
      .check();
    const ctx = await e.browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await ctx.route("**/*", (r) =>
      new URL(r.request().url()).hostname === "127.0.0.1"
        ? r.continue()
        : r.abort(),
    );
    const second = await ctx.newPage();
    second.setDefaultTimeout(15000);
    await login(e, "collaborator", second);
    await second.goto(href(e, e.g.id));
    await btn(second, "Revise proposal").click();
    await second
      .getByLabel("Reason for this change")
      .fill("R13 fix1 proposer second-session revision");
    await second.getByLabel("Proposed target date").fill("2027-05-01");
    await btn(second, "Review comparison").click();
    await btn(second, "Publish proposal").click();
    await second.getByText(/Verified revise receipt/).waitFor();
    let a = await e.market.agreementAmendment(
      e.users.collaborator,
      e.g.id,
      e.amendmentId,
    );
    assert.equal(a.proposalRevision, 2);
    assert.equal(a.participants.filter((x) => x.confirmation).length, 0);
    await btn(publisher, "Confirm this revision").click();
    await publisher
      .getByText(/older version|Current history has been loaded/)
      .waitFor();
    await btn(publisher, "Refresh changes").click();
    await publisher
      .getByRole("checkbox", { name: /I reviewed proposal revision 2,/ })
      .waitFor();
    assert.equal(
      await publisher
        .getByRole("checkbox", { name: /I reviewed proposal revision/ })
        .isChecked(),
      false,
    );
    assert.equal(
      await btn(publisher, "Confirm this revision").isEnabled(),
      false,
    );
    await btn(first, "Review comparison").click();
    await btn(first, "Publish proposal").click();
    await first
      .getByRole("heading", { name: "The agreement or proposal changed" })
      .waitFor();
    assert.equal(
      await first.getByLabel("Reason for this change").inputValue(),
      "R13 fix1 retained stale revision edits",
    );
    assert.equal(
      await first.getByLabel("General scope").inputValue(),
      "R13 fix1 first-session retained scope",
    );
    assert.equal(await btn(first, "Review comparison").isEnabled(), false);
    await btn(first, "Refresh changes").click();
    await btn(first, "Keep edits and review current terms").click();
    await btn(first, "Review comparison").click();
    await btn(first, "Publish proposal").click();
    await first
      .getByText(/Verified revise receipt for proposal revision 3/)
      .waitFor();
    a = await e.market.agreementAmendment(
      e.users.collaborator,
      e.g.id,
      e.amendmentId,
    );
    assert.equal(a.proposalRevision, 3);
    assert.equal(a.participants.filter((x) => x.confirmation).length, 0);
    await first.screenshot({
      path: path.join(e.evidence, "same-proposal-revision3-390.png"),
      fullPage: true,
    });
    record(
      e,
      "legal same-proposal second proposer session revision with stale editor and confirmation",
      {
        agreementId: e.g.id,
        amendmentId: e.amendmentId,
        revision: a.proposalRevision,
        retainedReason: a.reason,
        confirmationReset: true,
        noAutomaticReconfirm: true,
        participants: a.participants,
      },
    );
    await ctx.close();
  }

  if (phase === "sessionfinish") {
    const events = await e.market.amendmentEvents(
      e.users.collaborator,
      e.g.id,
      e.amendmentId,
      { limit: "20" },
    );
    assert.equal(
      events.items.filter((x) => x.operation === "propose").length,
      1,
    );
    record(
      e,
      "resumed readback after query-schema mistake; account-switch request recovery already verified before failed event GET",
      {
        agreementId: e.g.id,
        amendmentId: e.amendmentId,
        postAttempts: 3,
        sameBody: true,
        sameKey: true,
        assertionsExecutedInPreviousPhaseBeforeReadbackError: true,
        proposeEvents: 1,
        events: events.items,
      },
    );
  }
  if (phase === "outsidercontext") {
    const p = e.pages.outsider;
    const destination =
      href(e, e.g.id) +
      `&amendmentId=${e.amendmentId}&proposalRevision=1#amendment-${e.amendmentId}-revision-1`;
    const read = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/agreements/" + e.g.id) &&
        r.request().method() === "GET",
    );
    await p.goto(destination);
    const response = await read;
    assert.equal(response.status(), 404);
    await p
      .getByText(/not found|unavailable|not available/i)
      .first()
      .waitFor();
    assert.equal(await btn(p, "Recover request").count(), 0);
    await p.screenshot({
      path: path.join(e.evidence, "outsider-context-denied-1440.png"),
      fullPage: true,
    });
    record(e, "exact notification query/hash direct link outsider denial", {
      destination,
      httpStatus: 404,
      amendmentId: e.amendmentId,
      requestedRevision: 1,
      membershipRevocation: false,
    });
  }
}
