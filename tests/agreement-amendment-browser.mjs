// Runs only inside the controller-released owned Task3 harness. Never stores sessions or OTPs.
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
export async function run(e, phase) {
  if (phase === "setup") {
    for (const role of Object.keys(e.users)) {
      if (e.pages[role]) continue;
      const context = await e.browser.newContext({
        viewport: { width: role === "collaborator" ? 390 : 1440, height: 1000 },
      });
      await context.route("**/*", (route) => {
        const u = new URL(route.request().url());
        return u.hostname === "127.0.0.1" ||
          ["data:", "blob:"].includes(u.protocol)
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      e.pages[role] = page;
      await login(e, role, page);
    }
    e.scenarios.lifecycle = await createAgreement(e, "lifecycle");
    e.scenarios.work = await createAgreement(e, "historical work");
    e.scenarios.funds = await createAgreement(e, "funds boundary");
    const g = e.scenarios.lifecycle,
      p = await open(e, "publisher", g.id);
    await p
      .getByText("Agreement changes are unavailable in this environment.")
      .waitFor();
    assert.equal(await btn(p, "Start a new proposal").count(), 0);
    record(e, "disabled017 rendered compatibility", {
      agreementId: g.id,
      capability: await e.market.capabilities(e.users.publisher),
    });
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true,strict_binding=true WHERE singleton",
    );
    e.journal({
      action: "isolated_strict_activation",
      database: e.release.database,
    });
  }
  if (phase === "lifecycle") {
    const g = e.scenarios.lifecycle;
    const a = await proposal(e, "collaborator", g.id, async (p) => {
      await p.getByLabel("Proposed target date").fill("2027-03-15");
      await p
        .getByLabel("Stage 2 acceptance criteria")
        .fill("R13 new report analysis");
      await p
        .getByLabel("Reason for this change")
        .fill("R13 date and future criteria refinement");
    });
    e.first = a;
    assert.equal(a.participants.filter((p) => p.confirmation).length, 0);
    await e.pages.collaborator.screenshot({
      path: path.join(e.evidence, "author-unconfirmed-390.png"),
      fullPage: true,
    });
    record(e, "browser author remains unconfirmed", {
      agreementId: g.id,
      amendmentId: a.id,
      revision: 1,
      participants: a.participants,
    });
    await confirm(e, "captain", g.id);
    const p = await open(e, "collaborator", g.id);
    await btn(p, "Revise proposal").click();
    await p.getByLabel("Proposed target date").fill("2027-03-16");
    await p
      .getByLabel("Reason for this change")
      .fill("R13 revision two resets confirmations");
    await btn(p, "Review comparison").click();
    await btn(p, "Publish proposal").click();
    await p.getByText(/Verified revise receipt/).waitFor();
    const a2 = await e.market.agreementAmendment(e.users.publisher, g.id, a.id);
    assert.equal(a2.proposalRevision, 2);
    assert.ok(a2.participants.every((p) => !p.confirmation));
    record(e, "browser revision resets confirmations", { proposal: a2 });
    for (const role of ["publisher", "captain", "collaborator"])
      await confirm(e, role, g.id);
    const current = await e.market.agreement(e.users.publisher, g.id);
    assert.equal(current.effectiveTerms.id, a2.proposedTerms.id);
    assert.equal(current.state, "awaiting_funding");
    record(e, "browser three individual confirmations effective nonmoney", {
      agreementId: g.id,
      effectiveTerms: current.effectiveTerms,
      state: current.state,
    });
    const old = e.pages.publisher;
    await old.goto(
      `${href(e, g.id)}&amendmentId=${a.id}&proposalRevision=1#amendment-${a.id}-revision-1`,
    );
    await old
      .getByText("Historical revision 1. Current revision is 2.")
      .waitFor();
    await old.locator(`#amendment-${a.id}-revision-1`).waitFor();
    assert.equal(
      await old
        .locator(`#amendment-${a.id}-revision-1`)
        .getByText("Confirmed revision 1", { exact: true })
        .count(),
      1,
    );
    await old.screenshot({
      path: path.join(e.evidence, "historical-revision-1440.png"),
      fullPage: true,
    });
    record(e, "exact historical deep link", {
      amendmentId: a.id,
      revision: 1,
      confirmationCount: 1,
    });
  }
  if (phase === "work") {
    const g = e.scenarios.work;
    if (!e.activated) {
      assert.equal(
        e.release.database,
        "campus_r13_65909ddca2db4305a61e1b3c7340a2cf",
      );
      const r = await e.owner.query(
        "UPDATE campus.agreements SET state='active' WHERE id=$1 AND state='awaiting_funding'",
        [g.id],
      );
      assert.equal(r.rowCount, 1);
      e.activated = g.id;
      e.journal({
        action: "exact_synthetic_activation",
        agreementId: g.id,
        rowCount: r.rowCount,
        synthetic_activation: true,
        fundingEvidence: false,
      });
    }
    const p = await open(e, "captain", g.id),
      m1 = p.locator(`#milestone-${g.milestones[0].id}`);
    if (
      !(await e.market.submissions(e.users.captain, g.milestones[0].id)).length
    ) {
      await m1
        .getByLabel("Your deliverable")
        .fill("R13 dataset submitted under original T1");
      await m1
        .getByRole("button", { name: "Submit for review", exact: true })
        .click();
    }
    await m1
      .getByRole("heading", {
        name: "Latest submission · Version 1",
        exact: true,
      })
      .waitFor();
    const before = await e.market.submissions(
      e.users.captain,
      g.milestones[0].id,
    );
    assert.equal(before[0].submissionTermsId, g.effectiveTerms.id);
    const a = await proposal(e, "collaborator", g.id, async (p) => {
      await p.getByLabel("Proposed target date").fill("2027-04-01");
      await p
        .getByLabel("General scope")
        .fill(
          "R13 future scope clarified; old reviews preserve their own original scope.",
        );
      await p
        .getByLabel("Stage 2 acceptance criteria")
        .fill("R13 revised future report criteria");
      await p
        .getByLabel("Reason for this change")
        .fill("R13 preserve existing work and clarify future work");
      assert.equal(await p.getByLabel("Stage 1 title").isDisabled(), true);
    });
    for (const role of ["publisher", "captain", "collaborator"])
      await confirm(e, role, g.id);
    const pub = await open(e, "publisher", g.id),
      old = pub.locator(`#milestone-${g.milestones[0].id}`);
    await old.getByText(/Submitted under terms 1/).waitFor();
    await old
      .getByRole("checkbox", { name: /I have reviewed version 1/ })
      .check();
    await old
      .getByRole("button", { name: "Accept version 1", exact: true })
      .click();
    await old
      .getByText(/Accepted ·/)
      .first()
      .waitFor();
    await pub.screenshot({
      path: path.join(e.evidence, "historical-review-1440.png"),
      fullPage: true,
    });
    const next = await open(e, "captain", g.id),
      m2 = next.locator(`#milestone-${g.milestones[1].id}`);
    await m2
      .locator(".cb-milestone-requirements")
      .getByText(/R13 revised future report criteria/)
      .waitFor();
    await m2
      .getByLabel("Your deliverable")
      .fill("R13 report submitted under current T2");
    await m2
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await m2
      .getByRole("heading", {
        name: "Latest submission · Version 1",
        exact: true,
      })
      .waitFor();
    const after = await e.market.submissions(
        e.users.captain,
        g.milestones[1].id,
      ),
      reviews = await e.market.milestoneReviews(
        e.users.publisher,
        g.milestones[0].id,
      );
    assert.equal(after[0].submissionTermsId, a.proposedTerms.id);
    record(e, "browser historical work identities", {
      synthetic_activation: true,
      agreementId: g.id,
      firstSubmission: before[0],
      laterSubmission: after[0],
      reviews,
    });
  }
  if (phase === "workfinish") {
    const g = e.scenarios.work,
      current = await e.market.agreement(e.users.publisher, g.id),
      p = await open(e, "captain", g.id),
      m2 = p.locator(`#milestone-${g.milestones[1].id}`);
    await m2
      .locator(".cb-milestone-requirements")
      .getByText(/R13 revised future report criteria/)
      .waitFor();
    await m2
      .getByLabel("Your deliverable")
      .fill("R13 report submitted under current T2");
    await m2
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await m2
      .getByRole("heading", {
        name: "Latest submission · Version 1",
        exact: true,
      })
      .waitFor();
    const first = await e.market.submissions(
        e.users.captain,
        g.milestones[0].id,
      ),
      later = await e.market.submissions(e.users.captain, g.milestones[1].id),
      reviews = await e.market.milestoneReviews(
        e.users.publisher,
        g.milestones[0].id,
      );
    assert.equal(first[0].submissionTermsId, g.effectiveTerms.id);
    assert.equal(later[0].submissionTermsId, current.effectiveTerms.id);
    assert.notEqual(current.effectiveTerms.id, g.effectiveTerms.id);
    assert.equal(reviews[0].submission.submissionTermsId, g.effectiveTerms.id);
    record(e, "browser historical work identities", {
      synthetic_activation: true,
      agreementId: g.id,
      firstSubmission: first[0],
      laterSubmission: later[0],
      reviews,
    });
  }
  if (phase === "funds") {
    const g = e.scenarios.funds;
    for (const mode of [
      "increase",
      "decrease",
      "reallocation",
      "add",
      "retire",
    ]) {
      const a = await proposal(e, "collaborator", g.id, async (p) => {
        if (mode === "increase") {
          await p.getByLabel("Proposed total reward (USD)").fill("12.00");
          await p.getByLabel("Stage 2 reward (USD)").fill("8.00");
        }
        if (mode === "decrease") {
          await p.getByLabel("Proposed total reward (USD)").fill("9.00");
          await p.getByLabel("Stage 2 reward (USD)").fill("5.00");
        }
        if (mode === "reallocation") {
          await p.getByLabel("Stage 1 reward (USD)").fill("5.00");
          await p.getByLabel("Stage 2 reward (USD)").fill("5.00");
        }
        if (mode === "add") {
          await btn(p, "Add future stage").click();
          await p.getByLabel("Stage 3 title").fill("Follow-up");
          await p.getByLabel("Stage 3 deliverable").fill("Extra report");
          await p.getByLabel("Stage 3 reward (USD)").fill("2.00");
          await p.getByLabel("Proposed total reward (USD)").fill("12.00");
        }
        if (mode === "retire") {
          await p
            .getByRole("checkbox", { name: "Retire this untouched stage" })
            .nth(1)
            .check();
          await p.getByLabel("Proposed total reward (USD)").fill("4.00");
        }
        await p
          .getByLabel("Reason for this change")
          .fill(`R13 ${mode} funds boundary`);
      });
      for (const role of ["publisher", "captain", "collaborator"])
        await confirm(e, role, g.id);
      const current = await e.market.agreement(e.users.publisher, g.id);
      assert.equal(current.amendmentSummary.status, "agreed_waiting_funds");
      assert.equal(current.effectiveTerms.id, g.effectiveTerms.id);
      assert.equal(current.state, "awaiting_funding");
      record(e, "browser unanimous funds boundary", {
        mode,
        agreementId: g.id,
        amendmentId: a.id,
        unchangedEffectiveTermsId: current.effectiveTerms.id,
        funding: current.funding,
      });
      if (mode === "add")
        await e.pages.collaborator.screenshot({
          path: path.join(e.evidence, "funds-waiting-390.png"),
          fullPage: true,
        });
      await end(
        e,
        "collaborator",
        g.id,
        mode === "retire" ? "Withdraw proposal" : "Reject proposal",
      );
    }
  }
  if (phase === "recovery") {
    const g = e.scenarios.lifecycle,
      p = e.pages.collaborator;
    let captured = null;
    const pattern = `**/api/v1/agreements/${g.id}/amendments`;
    await p.route(pattern, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      captured = {
        body: route.request().postData(),
        key: route.request().headers()["idempotency-key"],
        url: route.request().url(),
      };
      const response = await route.fetch();
      const result = await response.json();
      e.lostResult = result;
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: '{"unexpected":"controlled lost response after commit"}',
      });
      await p.unroute(pattern);
    });
    await open(e, "collaborator", g.id);
    await btn(p, "Start a new proposal").click();
    await p.getByLabel("Proposed target date").fill("2027-05-02");
    await p
      .getByLabel("Reason for this change")
      .fill("R13 exact unknown-outcome recovery");
    await btn(p, "Review comparison").click();
    await btn(p, "Publish proposal").click();
    await btn(p, "Recover request").waitFor();
    assert.ok(captured);
    const frozen = await p.evaluate(
      ({ user, gid }) =>
        JSON.parse(
          sessionStorage.getItem(`campus:amendment-request:${user}:${gid}`),
        ),
      { user: e.users.collaborator, gid: g.id },
    );
    assert.equal(JSON.stringify(frozen.body), captured.body);
    assert.equal(frozen.key, captured.key);
    await p.reload();
    await btn(p, "Recover request").waitFor();
    let recovered;
    await p.route(pattern, async (route) => {
      if (route.request().method() === "POST")
        recovered = {
          body: route.request().postData(),
          key: route.request().headers()["idempotency-key"],
        };
      return route.continue();
    });
    await btn(p, "Recover request").click();
    await p.getByText(/Verified propose receipt/).waitFor();
    await p.unroute(pattern);
    assert.deepEqual(recovered, { body: captured.body, key: captured.key });
    const events = await e.market.amendmentEvents(
      e.users.collaborator,
      g.id,
      e.lostResult.receipt.amendmentId,
    );
    assert.equal(
      events.items.filter((v) => v.operation === "propose").length,
      1,
    );
    record(e, "controlled malformed response exact recovery after reload", {
      agreementId: g.id,
      receipt: e.lostResult.receipt,
      sameBody: true,
      sameKey: true,
      proposalEvents: events.items.filter((v) => v.operation === "propose")
        .length,
    });
    await end(e, "collaborator", g.id, "Withdraw proposal");
  }
  if (phase === "stale") {
    const g = e.scenarios.lifecycle,
      p = await open(e, "publisher", g.id);
    await btn(p, "Start a new proposal").click();
    await p.getByLabel("Proposed target date").fill("2027-06-01");
    await p
      .getByLabel("Reason for this change")
      .fill("R13 retained publisher private draft");
    const current = await e.market.agreement(e.users.collaborator, g.id);
    const input = {
      expectedEffectiveTermsId: current.effectiveTerms.id,
      expectedEffectiveRevision: current.effectiveTerms.revision,
      reason: "R13 another party publishes while a draft is open",
      terms: {
        taskTitle: current.effectiveTerms.terms.taskTitle,
        description: current.effectiveTerms.terms.description,
        dueDate: "2027-06-02",
        rewardCents: 1000,
        currency: "USD",
        milestones: current.effectiveTerms.milestones,
        retireMilestoneIds: [],
      },
    };
    const created = await e.market.proposeAmendment(
      e.users.collaborator,
      g.id,
      input,
      key(),
    );
    await btn(p, "Review comparison").click();
    await btn(p, "Publish proposal").click();
    await p
      .getByRole("heading", { name: "The agreement or proposal changed" })
      .waitFor();
    assert.equal(
      await p.getByLabel("Reason for this change").inputValue(),
      "R13 retained publisher private draft",
    );
    assert.equal(await btn(p, "Review comparison").isDisabled(), true);
    const a = await e.market.agreementAmendment(
      e.users.collaborator,
      g.id,
      created.receipt.amendmentId,
    );
    await e.market.withdrawAmendment(
      e.users.collaborator,
      g.id,
      a.id,
      { ...consent(a), reason: "R13 release competing proposal slot" },
      key(),
    );
    await btn(p, "Refresh changes").click();
    await btn(p, "Keep edits and review current terms").click();
    await btn(p, "Review comparison").click();
    await btn(p, "Publish proposal").click();
    await p.getByText(/Verified propose receipt/).waitFor();
    record(
      e,
      "ordinary concurrent-party 409 retains edits then explicit review",
      {
        agreementId: g.id,
        retainedReason: "R13 retained publisher private draft",
        concurrentSetup: "collaborator ordinary propose/withdraw service calls",
      },
    );
    await end(e, "publisher", g.id, "Withdraw proposal");
  }
  if (phase === "accessibility") {
    const g = e.scenarios.funds,
      p = await open(e, "collaborator", g.id);
    await btn(p, "Start a new proposal").click();
    await p
      .getByLabel("Reason for this change")
      .fill("R13 layout and keyboard draft");
    await p.getByLabel("General scope").fill("Long scope ".repeat(140));
    const layouts = [];
    for (const width of [320, 390, 768, 1024, 1440]) {
      await p.setViewportSize({ width, height: 1000 });
      const metrics = await p.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      assert.ok(metrics.content <= metrics.viewport, `no overflow at ${width}`);
      layouts.push({ width, ...metrics });
      if ([390, 1440].includes(width))
        await p.screenshot({
          path: path.join(e.evidence, `draft-${width}.png`),
          fullPage: true,
        });
    }
    const review = btn(p, "Review comparison");
    await review.focus();
    await p.keyboard.press("Enter");
    await p.getByRole("dialog").waitFor();
    await p.keyboard.press("Escape");
    assert.equal(
      await review.evaluate((el) => el === document.activeElement),
      true,
    );
    await p.keyboard.press("Enter");
    await p.getByRole("dialog").waitFor();
    await btn(p, "Back to editing").focus();
    await p.keyboard.press("Enter");
    assert.equal(
      await review.evaluate((el) => el === document.activeElement),
      true,
    );
    await p.addScriptTag({
      path: path.join(e.root, "node_modules/axe-core/axe.min.js"),
    });
    const axe = await p.evaluate(async () => {
      const r = await axe.run(document.querySelector(".cb-amendments"));
      return {
        violations: r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            failureSummary: n.failureSummary,
          })),
        })),
        passes: r.passes.length,
        incomplete: r.incomplete.length,
      };
    });
    fs.writeFileSync(
      path.join(e.evidence, "axe-amendments.json"),
      JSON.stringify(axe, null, 2),
    );
    assert.deepEqual(axe.violations, []);
    const tree = await p.locator(".cb-amendments").ariaSnapshot();
    fs.writeFileSync(
      path.join(e.evidence, "amendment-accessibility-tree.txt"),
      tree,
    );
    record(e, "rendered responsive and keyboard checks", {
      layouts,
      dialogEscapeRestoredFocus: true,
      dialogBackRestoredFocus: true,
      axe,
    });
    await btn(p, "Close draft (keep edits)").click();
  }

  if (phase === "navigation") {
    const g = e.scenarios.funds,
      p = await open(e, "collaborator", g.id);
    // A sixth ordinary browser proposal crosses the five-item proposal page boundary.
    const a = await proposal(e, "collaborator", g.id, async (page) => {
      await page.getByLabel("Proposed target date").fill("2027-08-01");
      await page
        .getByLabel("Reason for this change")
        .fill("R13 sixth proposal for cursor navigation");
    });
    await end(e, "collaborator", g.id, "Withdraw proposal");
    await btn(p, "Load more proposals").click();
    await p
      .getByRole("button", {
        name: /Open proposal revision 1: R13 increase funds boundary/,
      })
      .waitFor();
    await p.getByText("Terms snapshots", { exact: true }).click();
    await btn(p, "Load more terms").click();
    await p
      .getByText("Terms 1 · accepted application", { exact: true })
      .waitFor();
    const first = e.first,
      life = e.scenarios.lifecycle,
      pub = e.pages.publisher;
    await pub.goto(`${e.release.origin}/?view=notifications`);
    await btn(pub, "Next page").waitFor();
    let link = pub
      .locator(`a[href*="amendmentId=${first.id}"][href*="proposalRevision=1"]`)
      .first();
    for (let i = 0; i < 8 && !(await link.count()); i++) {
      const more = btn(pub, "Next page");
      if (!(await more.count()) || (await more.isDisabled())) break;
      const response = pub.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/notifications") &&
          r.request().method() === "GET",
      );
      await more.click();
      await response;
      await pub
        .getByRole("link", { name: "Open update", exact: true })
        .first()
        .waitFor();
    }
    if (!(await link.count())) {
      const body = await pub.locator("main").innerText();
      throw Error(
        "Old exact notification link missing; visible controls: " +
          body.slice(-450),
      );
    }
    const destination = await link.getAttribute("href");
    await link.click();
    await pub.locator(`#amendment-${first.id}-revision-1`).waitFor();
    await pub
      .getByText("Proposal events and earlier revisions", { exact: true })
      .click();
    await btn(pub, "Load more events").click();
    await pub
      .getByRole("button", { name: "Revision 1: propose", exact: true })
      .waitFor();
    record(e, "actual old notification and independent cursor streams", {
      destination,
      requestedRevision: 1,
      proposalPageBoundary: true,
      termsPageBoundary: true,
      eventPageBoundary: true,
    });
  }
  if (phase === "roles") {
    const g = e.scenarios.lifecycle,
      o = e.pages.outsider;
    await o.goto(href(e, g.id));
    await o.getByText("We couldn’t finish that.", { exact: true }).waitFor();
    assert.equal(await btn(o, "Start a new proposal").count(), 0);
    assert.equal(
      await o
        .getByRole("heading", { name: g.terms.taskTitle, exact: true })
        .count(),
      0,
    );
    record(e, "outsider denied agreement UI", { agreementId: g.id });
    const b = e.pages.collaborator;
    await open(e, "collaborator", g.id);
    await btn(b, "Start a new proposal").click();
    await b
      .getByLabel("Reason for this change")
      .fill("R13 private collaborator draft must not leak");
    await btn(b, "Sign out").click();
    await b.getByLabel("University email", { exact: true }).waitFor();
    await login(e, "outsider", b);
    await b.goto(href(e, g.id));
    await b.getByText("We couldn’t finish that.", { exact: true }).waitFor();
    assert.equal(
      await b
        .getByText("R13 private collaborator draft must not leak", {
          exact: true,
        })
        .count(),
      0,
    );
    record(e, "same browser account switch isolates private draft", {
      from: "collaborator",
      to: "outsider",
      renderedDraftLeak: false,
    });
    await btn(b, "Sign out").click();
    await login(e, "collaborator", b);
    const p = await b.context().newPage();
    await p.addInitScript(() => {
      Storage.prototype.setItem = function () {
        throw new DOMException(
          "Synthetic storage denial",
          "QuotaExceededError",
        );
      };
    });
    await p.goto(href(e, g.id));
    await btn(p, "Start a new proposal").click();
    await p
      .getByLabel("Reason for this change")
      .fill("R13 in-memory draft survives storage failure");
    assert.equal(
      await p.getByLabel("Reason for this change").inputValue(),
      "R13 in-memory draft survives storage failure",
    );
    await p.getByLabel("Proposed target date").fill("2027-07-01");
    await btn(p, "Review comparison").click();
    await p.getByRole("dialog").waitFor();
    await btn(p, "Back to editing").click();
    assert.equal(
      await p.getByLabel("Reason for this change").inputValue(),
      "R13 in-memory draft survives storage failure",
    );
    record(e, "storage failure retains in-memory editable draft", {
      storagePersistenceClaim: false,
    });
    await p.close();
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false WHERE singleton",
    );
    e.journal({
      action: "isolated_mutation_disable_latch",
      database: e.release.database,
    });
    const pub = await open(e, "publisher", g.id);
    await pub
      .getByText("Agreement changes are unavailable in this environment.")
      .waitFor();
    assert.equal(await btn(pub, "Start a new proposal").count(), 0);
    const cap = await e.market.capabilities(e.users.publisher);
    assert.equal(cap.agreementTermsBinding, "explicit");
    record(e, "disabled017 history and strict binding latch", {
      capability: cap,
    });
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true WHERE singleton",
    );
  }

  if (phase === "notificationfinish") {
    const first = e.first,
      g = e.scenarios.lifecycle,
      pub = e.pages.publisher;
    await pub.goto(`${e.release.origin}/?view=notifications`);
    await btn(pub, "Next page").waitFor();
    let link = pub
      .locator(`a[href*="amendmentId=${first.id}"][href*="proposalRevision=1"]`)
      .first();
    for (let i = 0; i < 8 && !(await link.count()); i++) {
      const more = btn(pub, "Next page");
      if (await more.isDisabled()) break;
      const response = pub.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/notifications") &&
          r.request().method() === "GET",
      );
      await more.click();
      await response;
      await pub
        .getByRole("link", { name: "Open update", exact: true })
        .first()
        .waitFor();
    }
    await link.waitFor();
    const destination = await link.getAttribute("href");
    await link.click();
    await pub.locator(`#amendment-${first.id}-revision-1`).waitFor();
    await pub
      .getByText("Proposal events and earlier revisions", { exact: true })
      .click();
    await btn(pub, "Load more events").click();
    await pub
      .getByRole("button", { name: "Revision 1: propose", exact: true })
      .waitFor();
    record(e, "actual old notification and cursor streams", {
      destination,
      requestedRevision: 1,
      proposalPageBoundary: "passed before navigation synchronization failure",
      termsPageBoundary: "passed before navigation synchronization failure",
      eventPageBoundary: true,
    });
  }

  if (phase === "workstale") {
    const g = e.scenarios.work,
      current = await e.market.agreement(e.users.captain, g.id),
      p = await open(e, "captain", g.id),
      m = p.locator(`#milestone-${g.milestones[1].id}`);
    await m
      .getByLabel("Revised deliverable")
      .fill("R13 retained revised work across a date-only terms change");
    const input = {
      expectedEffectiveTermsId: current.effectiveTerms.id,
      expectedEffectiveRevision: current.effectiveTerms.revision,
      reason: "R13 ordinary date-only change while work draft remains open",
      terms: {
        taskTitle: current.effectiveTerms.terms.taskTitle,
        description: current.effectiveTerms.terms.description,
        dueDate: "2027-09-01",
        rewardCents: 1000,
        currency: "USD",
        milestones: current.effectiveTerms.milestones,
        retireMilestoneIds: [],
      },
    };
    const created = await e.market.proposeAmendment(
        e.users.collaborator,
        g.id,
        input,
        key(),
      ),
      a = await e.market.agreementAmendment(
        e.users.publisher,
        g.id,
        created.receipt.amendmentId,
      );
    for (const role of ["publisher", "captain", "collaborator"])
      await e.market.confirmAmendment(
        e.users[role],
        g.id,
        a.id,
        consent(a),
        key(),
      );
    const post = p.waitForResponse(
      (r) =>
        r.url().endsWith(`/milestones/${g.milestones[1].id}/submissions`) &&
        r.request().method() === "POST",
    );
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .click();
    assert.equal((await post).status(), 409);
    await m
      .getByRole("button", {
        name: "Keep draft and review latest version",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await m.getByLabel("Revised deliverable").inputValue(),
      "R13 retained revised work across a date-only terms change",
    );
    assert.equal(
      await m
        .getByRole("button", { name: "Submit new version", exact: true })
        .isDisabled(),
      true,
    );
    await m
      .getByRole("button", { name: "Refresh milestone", exact: true })
      .click();
    await m
      .getByRole("button", {
        name: "Keep draft and review latest version",
        exact: true,
      })
      .click();
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .click();
    await m
      .getByRole("heading", {
        name: "Latest submission · Version 2",
        exact: true,
      })
      .waitFor();
    const submissions = await e.market.submissions(
      e.users.publisher,
      g.milestones[1].id,
    );
    assert.equal(submissions[1].submissionTermsId, a.proposedTerms.id);
    record(
      e,
      "date-only effective identity stales work draft without changing work revision",
      {
        agreementId: g.id,
        oldTermsId: current.effectiveTerms.id,
        newTermsId: a.proposedTerms.id,
        staleResponse: 409,
        retainedText: true,
        explicitRefresh: true,
        submission: submissions[1],
        concurrentChange:
          "ordinary service proposal and individual confirmations",
      },
    );
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false WHERE singleton",
    );
    const pub = await open(e, "publisher", g.id),
      review = pub.locator(`#milestone-${g.milestones[1].id}`);
    await review
      .getByLabel("Changes needed")
      .fill("R13 correct citations within the same agreed criteria");
    await review
      .getByRole("button", {
        name: "Request changes to version 2",
        exact: true,
      })
      .click();
    await review
      .getByRole("heading", { name: /Changes requested.*Version 2/ })
      .waitFor();
    const reviews = await e.market.milestoneReviews(
      e.users.publisher,
      g.milestones[1].id,
    );
    assert.equal(
      reviews.at(-1).submission.submissionTermsId,
      a.proposedTerms.id,
    );
    record(e, "mutation disable retains explicit historical work review", {
      capability: await e.market.capabilities(e.users.publisher),
      review: reviews.at(-1),
    });
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true WHERE singleton",
    );
  }

  if (phase === "inspectwork") {
    const g = e.scenarios.work,
      p = e.pages.captain,
      box = p.locator(`#milestone-${g.milestones[1].id}`);
    record(e, "work-stale diagnostic UI readback", {
      text: await box.innerText(),
      draft: await p.evaluate(
        ({ user, id }) =>
          sessionStorage.getItem(`campus:fulfillment-draft:${user}:${id}`),
        { user: e.users.captain, id: g.milestones[1].id },
      ),
      current: await e.market.agreement(e.users.publisher, g.id),
    });
    console.log((await box.innerText()).slice(-2200));
  }

  if (phase === "workstalefinish") {
    const g = e.scenarios.work,
      p = e.pages.captain,
      m = p.locator(`#milestone-${g.milestones[1].id}`);
    await m
      .getByRole("button", { name: "Refresh milestone", exact: true })
      .click();
    await m
      .getByRole("button", {
        name: "Keep draft and review latest version",
        exact: true,
      })
      .click();
    record(e, "work draft explicit keep readback", {
      draft: await p.evaluate(
        ({ user, id }) =>
          sessionStorage.getItem(`campus:fulfillment-draft:${user}:${id}`),
        { user: e.users.captain, id: g.milestones[1].id },
      ),
      text: await m.innerText(),
    });
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .click();
    await m
      .getByRole("heading", {
        name: "Latest submission · Version 2",
        exact: true,
      })
      .waitFor();
    const current = await e.market.agreement(e.users.publisher, g.id),
      submissions = await e.market.submissions(
        e.users.publisher,
        g.milestones[1].id,
      );
    assert.equal(submissions[1].submissionTermsId, current.effectiveTerms.id);
    record(e, "date-only effective identity stale work recovered explicitly", {
      agreementId: g.id,
      staleResponse: 409,
      retainedText: true,
      explicitRefresh: true,
      submission: submissions[1],
    });
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=false WHERE singleton",
    );
    const pub = await open(e, "publisher", g.id),
      review = pub.locator(`#milestone-${g.milestones[1].id}`);
    await review
      .getByLabel("Changes needed")
      .fill("R13 correct citations within the same agreed criteria");
    await review
      .getByRole("button", {
        name: "Request changes to version 2",
        exact: true,
      })
      .click();
    await review
      .getByRole("heading", { name: /Changes requested.*Version 2/ })
      .waitFor();
    const reviews = await e.market.milestoneReviews(
      e.users.publisher,
      g.milestones[1].id,
    );
    assert.equal(
      reviews.at(-1).submission.submissionTermsId,
      current.effectiveTerms.id,
    );
    record(e, "mutation disable retains explicit historical work review", {
      capability: await e.market.capabilities(e.users.publisher),
      review: reviews.at(-1),
    });
    await e.owner.query(
      "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true WHERE singleton",
    );
  }

  if (phase === "finalwork") {
    const g = e.scenarios.work,
      current = await e.market.agreement(e.users.captain, g.id),
      p = await open(e, "captain", g.id),
      m = p.locator(`#milestone-${g.milestones[1].id}`);
    await m
      .getByLabel("Revised deliverable")
      .fill("R13 final work draft: preserve through current terms refresh");
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .waitFor();
    await m
      .getByRole("button", { name: "Refresh milestone", exact: true })
      .click();
    const input = {
      expectedEffectiveTermsId: current.effectiveTerms.id,
      expectedEffectiveRevision: current.effectiveTerms.revision,
      reason: "R13 final date-only stale draft regression",
      terms: {
        ...current.effectiveTerms.terms,
        milestones: current.effectiveTerms.milestones,
        retireMilestoneIds: [],
        dueDate: "2027-10-01",
      },
    };
    delete input.terms.ownerId;
    delete input.terms.captainId;
    delete input.terms.taskId;
    delete input.terms.applicationId;
    delete input.terms.members;
    // Exact editable contract only; server-owned snapshot metadata is not sent.
    input.terms = {
      taskTitle: current.effectiveTerms.terms.taskTitle,
      description: current.effectiveTerms.terms.description,
      dueDate: "2027-10-01",
      rewardCents: current.effectiveTerms.terms.rewardCents,
      currency: "USD",
      milestones: current.effectiveTerms.milestones,
      retireMilestoneIds: [],
    };
    const result = await e.market.proposeAmendment(
        e.users.collaborator,
        g.id,
        input,
        key(),
      ),
      a = await e.market.agreementAmendment(
        e.users.publisher,
        g.id,
        result.receipt.amendmentId,
      );
    for (const role of ["publisher", "captain", "collaborator"])
      await e.market.confirmAmendment(
        e.users[role],
        g.id,
        a.id,
        consent(a),
        key(),
      );
    const response = p.waitForResponse(
      (r) =>
        r.url().endsWith(`/milestones/${g.milestones[1].id}/submissions`) &&
        r.request().method() === "POST",
    );
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .click();
    assert.equal((await response).status(), 409);
    await m
      .getByRole("button", { name: "Refresh milestone", exact: true })
      .click();
    await m
      .getByRole("button", {
        name: "Keep draft and review latest version",
        exact: true,
      })
      .click();
    await m
      .getByText(
        "Your draft is kept. Review it against the latest submission and feedback before sending.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await m.getByLabel("Revised deliverable").inputValue(),
      "R13 final work draft: preserve through current terms refresh",
    );
    await m
      .getByRole("button", { name: "Submit new version", exact: true })
      .click();
    await m
      .getByRole("heading", {
        name: "Latest submission · Version 3",
        exact: true,
      })
      .waitFor();
    const all = await e.market.submissions(
      e.users.publisher,
      g.milestones[1].id,
    );
    assert.equal(all.at(-1).submissionTermsId, a.proposedTerms.id);
    record(e, "final current-terms stale draft regression", {
      beforeTermsId: current.effectiveTerms.id,
      afterTermsId: a.proposedTerms.id,
      staleResponse: 409,
      textRetained: true,
      explicitFreshReview: true,
      submission: all.at(-1),
    });
  }

  if (phase === "finalui") {
    const g = e.scenarios.funds,
      p = await open(e, "collaborator", g.id);
    await btn(p, "Start a new proposal").click();
    await p
      .getByLabel("Reason for this change")
      .fill("R13 final rendered validation");
    await p.getByLabel("Proposed total reward (USD)").fill("10.001");
    await btn(p, "Review comparison").click();
    await p
      .getByRole("alert")
      .filter({ hasText: "Enter USD amounts" })
      .waitFor();
    assert.equal(await p.getByRole("dialog").isVisible(), false);
    assert.ok(
      await p.evaluate(() =>
        document.activeElement?.textContent?.includes("Enter USD amounts"),
      ),
    );
    await p.getByLabel("Proposed total reward (USD)").fill("10.00");
    await p.setViewportSize({ width: 390, height: 844 });
    await p.getByLabel("Agreement title").scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(e.evidence, "draft-fields-390.png") });
    await p.setViewportSize({ width: 1440, height: 1000 });
    await btn(p, "Review comparison").focus();
    await p.keyboard.press("Enter");
    await p.getByRole("dialog").waitFor();
    await p.screenshot({
      path: path.join(e.evidence, "comparison-dialog-1440.png"),
    });
    const focusBefore = await p.evaluate(() => document.activeElement?.tagName);
    await p.keyboard.press("Tab");
    await p.keyboard.press("Shift+Tab");
    await p.keyboard.press("Escape");
    assert.equal(
      await btn(p, "Review comparison").evaluate(
        (el) => el === document.activeElement,
      ),
      true,
    );
    await p.addScriptTag({
      path: path.join(e.root, "node_modules/axe-core/axe.min.js"),
    });
    const audit = await p.evaluate(async () => {
      const r = await axe.run(document.querySelector(".cb-amendments"));
      return {
        violations: r.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        passes: r.passes.length,
      };
    });
    assert.deepEqual(audit.violations, []);
    fs.writeFileSync(
      path.join(e.evidence, "axe-final.json"),
      JSON.stringify(audit, null, 2),
    );
    record(e, "final extracted components validation and focus", {
      invalidDecimalAnnounced: true,
      validationFocused: true,
      dialogKeyboard: true,
      focusBefore,
      audit,
    });
    await btn(p, "Close draft (keep edits)").click();
    const pub = e.pages.publisher;
    await pub.goto(
      `${href(e, e.scenarios.lifecycle.id)}&amendmentId=${e.first.id}&proposalRevision=9999#amendment-${e.first.id}-revision-9999`,
    );
    await pub
      .getByRole("heading", { name: "Changes unavailable", exact: true })
      .waitFor();
    assert.equal(
      await pub
        .getByRole("heading", { name: "Proposal revision 1", exact: true })
        .count(),
      0,
    );
    record(
      e,
      "unavailable exact revision does not substitute current proposal",
      { requestedRevision: 9999 },
    );
  }
}
