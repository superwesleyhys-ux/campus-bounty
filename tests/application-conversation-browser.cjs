// Round 10 Task 3: synthetic loopback UI engineering; no legacy backend suite.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID: key } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  seedPeople,
  withFixture,
  fixtureSessionLogin,
  origin,
  button,
  defaultTeamContext,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round10",
  `task-3-browser-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const resume = process.env.R10_RESUME_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.R10_RESUME_FIXTURE))
  : null;
const checks = [],
  audits = [],
  errors = [],
  expectedFaults = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let store, browser;
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
const url = (id) =>
  `${origin}/?view=workspace&tab=applications&resource=application&id=${id}`;
const open = async (p, id) => {
  await p.goto(url(id));
  await ready(p);
};
const refresh = async (p) => {
  await button(p, "Refresh messages").click();
  await ready(p);
};
async function api(p, route) {
  return p.evaluate(async (route) => {
    const r = await fetch("/api/v1/" + route);
    return { status: r.status, data: await r.json() };
  }, route);
}
async function send(p, body) {
  await p.getByLabel("Message", { exact: true }).fill(body);
  await button(p, "Send message").click();
  await conv(p)
    .getByText("Message sent and confirmed.", { exact: true })
    .waitFor();
  await ready(p);
}
async function audit(p, name) {
  const widths = [];
  for (const width of [320, 768, 1024, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} overflow ${width}`,
    );
    await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const violations = await p.evaluate(async () =>
      (await axe.run()).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map((n) => n.target),
      })),
    );
    widths.push({ width, violations });
    await p.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
    assert.deepEqual(violations, [], `${name} axe ${width}`);
  }
  audits.push({ name, widths });
  const input = p.getByLabel("Message", { exact: true });
  await input.focus();
  assert.ok(await input.evaluate((n) => n === document.activeElement));
  await p.keyboard.press("Shift+Tab");
  assert.ok(await p.evaluate(() => document.activeElement !== document.body));
  record(`${name}: four widths, axe and keyboard focus`);
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const fixture = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => {
      const u = connectionString(localConfig(), role, fixture.database);
      assert.equal(new URL(u).hostname, "127.0.0.1");
      return [role, u];
    }),
  );
  store = createStore(urls);
  const market = createMarket(store);
  const people =
    resume?.people ??
    (await seedPeople([
      "R10 Publisher",
      "R10 Applicant",
      "R10 Unconfirmed member",
      "R10 Later member",
      "R10 Foreign applicant",
    ]));
  const [owner, applicant, peer, later, foreign] = people;
  let team = resume?.team;
  if (!resume) {
    team = await market.createTeam(
      applicant.id,
      { name: "R10 Application team", context: defaultTeamContext },
      key(),
    );
    team = await market.inviteMember(
      applicant.id,
      team.id,
      { userId: peer.id, expectedRevision: team.revision },
      key(),
    );
    team = await market.acceptMembership(
      peer.id,
      team.id,
      { expectedRevision: team.revision },
      key(),
    );
  }
  async function task(label) {
    return market.publishTask(
      owner.id,
      {
        title: `R10 ${label} ${run}`,
        category: "Research",
        description: "Synthetic application discussion engineering",
        rewardCents: 100,
        milestones: [
          {
            title: "Evidence",
            amountCents: 100,
            deliverable: "Local evidence",
          },
        ],
      },
      key(),
    );
  }
  async function apply(t, teamId) {
    return market.apply(
      applicant.id,
      t.id,
      { proposal: "R10 proposal " + t.title, ...(teamId ? { teamId } : {}) },
      key(),
    );
  }
  const primaryTask = resume?.primaryTask ?? (await task("discussion")),
    primary = resume?.primary ?? (await apply(primaryTask, team.id));
  const acceptedTask = resume?.acceptedTask ?? (await task("acceptance")),
    acceptedApp = resume?.acceptedApp ?? (await apply(acceptedTask));
  const lossTask = resume?.lossTask ?? (await task("lost committed response")),
    lossApp = resume?.lossApp ?? (await apply(lossTask));
  const absentTask =
      resume?.absentTask ?? (await task("lost uncommitted request")),
    absentApp = resume?.absentApp ?? (await apply(absentTask));
  const otherTask = resume?.otherTask ?? (await task("isolated draft")),
    otherApp = resume?.otherApp ?? (await apply(otherTask));
  if (!resume) {
    team = await market.inviteMember(
      applicant.id,
      team.id,
      { userId: later.id, expectedRevision: team.revision },
      key(),
    );
    await market.acceptMembership(
      later.id,
      team.id,
      { expectedRevision: team.revision },
      key(),
    );
  }
  const oldest =
    resume?.oldest ??
    (
      await store.as(peer.id, (c) =>
        c.query(
          "INSERT INTO campus.messages(sender_id,application_id,body,created_at) SELECT $1,$2,CASE WHEN n=1 THEN 'R10 ancient needle [literal] % _' ELSE 'R10 history '||n END,'2026-01-01T00:00:00.123001Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,143)n RETURNING id,body",
          [peer.id, primary.id],
        ),
      )
    ).rows.find((r) => r.body.includes("ancient"));
  fs.mkdirSync(".data/qa", { recursive: true });
  fs.writeFileSync(
    `.data/qa/round10-task3-${run}.json`,
    JSON.stringify({
      people,
      team,
      primaryTask,
      primary,
      acceptedTask,
      acceptedApp,
      lossTask,
      lossApp,
      absentTask,
      absentApp,
      otherTask,
      otherApp,
      oldest,
    }),
    { mode: 0o600 },
  );
  browser = await chromium.launch({ headless: true });
  const pages = [];
  for (const person of people) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.stack));
    await fixtureSessionLogin(p, person);
    pages.push(p);
  }
  const [publisher, cap, member, joiner, stranger] = pages;
  if (!resume) {
    await publisher.goto(`${origin}/?view=bounties&id=${primaryTask.id}`);
    await publisher
      .getByRole("link", { name: "Open application discussion", exact: true })
      .click();
    await ready(publisher);
    await member.goto(`${origin}/?view=workspace&tab=applications`);
    const memberCard = member.locator(`#application-${primary.id}`);
    await memberCard.locator("summary").click();
    await memberCard
      .getByText("Waiting for consent", { exact: false })
      .waitFor();
    await memberCard
      .getByRole("link", { name: "Open application discussion", exact: true })
      .click();
    await ready(member);
    await cap.goto(`${origin}/?view=workspace&tab=applications`);
    await cap
      .locator(`#application-${primary.id}`)
      .getByRole("link", { name: "Open application discussion", exact: true })
      .click();
    await ready(cap);
    assert.match(
      await conv(member).textContent(),
      /including people who have not consented/,
    );
    assert.match(
      await conv(member).textContent(),
      /Chatting does not record consent or change bounty terms/,
    );
    assert.match(
      await conv(member)
        .getByRole("list", { name: "Conversation participants" })
        .textContent(),
      /Proposed participant/,
    );
    assert.doesNotMatch(await conv(member).textContent(), /Signed participant/);
    await send(member, "R10 unconfirmed real send");
    await refresh(cap);
    await conv(cap)
      .getByText("R10 unconfirmed real send", { exact: true })
      .waitFor();
    assert.equal(
      (await api(cap, `applications/${primary.id}`)).data.members.find(
        (m) => m.user_id === peer.id,
      ).confirmed,
      false,
    );
    record(
      "Publisher, applicant and unconfirmed member use real cards; actual counterpart readback; chat does not consent",
    );
    for (const p of [joiner, stranger]) {
      await p.goto(url(primary.id));
      await p.getByRole("alert").first().waitFor();
      assert.equal((await api(p, `applications/${primary.id}`)).status, 404);
      assert.equal(await conv(p).count(), 0);
    }
    record("Later team member and foreign applicant denied exact discussion");
    await audit(cap, "open-discussion");
    await cap.getByLabel("Message", { exact: true }).fill("R10 retained draft");
    await cap.goto(`${origin}/?view=workspace&tab=applications`);
    await open(cap, primary.id);
    assert.equal(
      await cap.getByLabel("Message", { exact: true }).inputValue(),
      "R10 retained draft",
    );
    await cap.reload();
    await ready(cap);
    assert.equal(
      await cap.getByLabel("Message", { exact: true }).inputValue(),
      "R10 retained draft",
    );
    await open(cap, otherApp.id);
    assert.equal(
      await cap.getByLabel("Message", { exact: true }).inputValue(),
      "",
    );
    await fixtureSessionLogin(cap, peer);
    await open(cap, primary.id);
    assert.equal(
      await cap.getByLabel("Message", { exact: true }).inputValue(),
      "",
    );
    await fixtureSessionLogin(cap, applicant);
    await open(cap, primary.id);
    assert.equal(
      await cap.getByLabel("Message", { exact: true }).inputValue(),
      "R10 retained draft",
    );
    record(
      "Draft route/reload retention and exact account/application isolation",
    );
    while (await button(cap, "Load older messages").isEnabled()) {
      await button(cap, "Load older messages").click();
      await conv(cap)
        .getByText(
          "Older messages loaded. Your reading position is preserved.",
          {
            exact: true,
          },
        )
        .waitFor();
    }
    assert.equal(await conv(cap).locator("[data-message-id]").count(), 144);
    await cap
      .getByRole("searchbox", { name: "Search this conversation", exact: true })
      .fill("ancient needle [literal] % _");
    await button(cap, "Search messages").click();
    await cap.locator(`[data-search-message-id="${oldest.id}"]`).waitFor();
    await button(cap, "Open message in context").click();
    await cap
      .locator(`[data-context-message-id="${oldest.id}"][aria-current="true"]`)
      .waitFor();
    await cap.waitForFunction(
      (id) =>
        document.activeElement?.getAttribute("data-context-message-id") === id,
      oldest.id,
    );
    assert.equal(new URL(cap.url()).searchParams.get("messageId"), oldest.id);
    await cap.reload();
    await ready(cap);
    await cap
      .locator(`[data-context-message-id="${oldest.id}"][aria-current="true"]`)
      .waitFor();
    record(
      "143+ history pagination, literal search, exact old-message context, focus and reload",
    );
    // Ordinary sequential reapplications create >100 real recent records; no lock/revocation diagnostics.
    const archiveTask = await task("archive population");
    for (let i = 0; i < 102; i++) {
      const a = await apply(archiveTask);
      await market.withdrawApplication(applicant.id, a.id, {}, key());
    }
  }
  const listed = (await api(cap, "applications")).data;
  assert.equal(listed.length, 100);
  assert.ok(!listed.some((a) => a.id === primary.id));
  await open(cap, primary.id);
  const note = (
    await withFixture((c) =>
      c.query(
        "SELECT id,read_at FROM campus.notifications WHERE recipient_id=$1 AND event_key=$2",
        [applicant.id, "message:" + oldest.id],
      ),
    )
  ).rows[0];
  assert.ok(note);
  assert.equal(note.read_at, null);
  async function notificationPage() {
    await cap.goto(`${origin}/?view=notifications`);
    for (let page = 1; page <= 30; page++) {
      await cap
        .locator(".cb-notification-tools p")
        .filter({ hasText: `· Page ${page}` })
        .waitFor();
      const row = cap.locator(`[data-notification-id="${note.id}"]`);
      if (await row.count()) return row;
      assert.ok(
        await button(cap, "Next page").isEnabled(),
        "Old notification must remain reachable",
      );
      await button(cap, "Next page").click();
    }
    throw new Error("Notification not found within 30 pages");
  }
  const noteCard = await notificationPage();
  await noteCard
    .getByRole("link", { name: "Open update", exact: true })
    .click();
  await ready(cap);
  assert.equal(new URL(cap.url()).searchParams.get("id"), primary.id);
  assert.equal(new URL(cap.url()).searchParams.get("messageId"), oldest.id);
  await cap
    .locator(`[data-context-message-id="${oldest.id}"][aria-current="true"]`)
    .waitFor();
  assert.equal(
    (
      await withFixture((c) =>
        c.query("SELECT read_at FROM campus.notifications WHERE id=$1", [
          note.id,
        ]),
      )
    ).rows[0].read_at,
    null,
  );
  const unreadNote = await notificationPage();
  await unreadNote
    .getByRole("button", { name: "Mark read", exact: true })
    .click();
  await unreadNote
    .getByRole("button", { name: "Mark read", exact: true })
    .waitFor({ state: "detached" });
  assert.ok(
    (
      await withFixture((c) =>
        c.query("SELECT read_at FROM campus.notifications WHERE id=$1", [
          note.id,
        ]),
      )
    ).rows[0].read_at,
  );
  record(
    "Exact application outside recent 100 opens from old-message notification; read acknowledgement explicit",
  );
  await open(cap, primary.id);
  if (resume)
    await cap.getByLabel("Message", { exact: true }).fill("R10 retained draft");
  await market.withdrawApplication(applicant.id, primary.id, {}, key());
  await button(cap, "Refresh application").click();
  await ready(cap);
  await conv(cap)
    .getByRole("heading", { name: "Application discussion is read-only" })
    .waitFor();
  assert.equal(await button(cap, "Send message").isEnabled(), false);
  assert.equal(
    await cap.getByLabel("Message", { exact: true }).inputValue(),
    "R10 retained draft",
  );
  const reapplied = await apply(primaryTask, team.id);
  await open(cap, reapplied.id);
  assert.equal(await conv(cap).locator("[data-message-id]").count(), 0);
  assert.equal(
    await cap.getByLabel("Message", { exact: true }).inputValue(),
    "",
  );
  await open(cap, primary.id);
  assert.equal(
    (await api(cap, `messages?applicationId=${primary.id}`)).data.length,
    100,
  );
  record(
    "Ordinary withdrawal refresh closes sending, preserves draft/history; reapplication has separate empty discussion",
  );
  await open(cap, acceptedApp.id);
  await send(cap, "R10 accepted application record");
  await market.inviteApplicant(owner.id, acceptedApp.id, {}, key());
  await refresh(cap);
  await send(cap, "R10 invited discussion record");
  const agreement = await market.acceptInvitation(
    applicant.id,
    acceptedApp.id,
    {},
    key(),
  );
  await refresh(cap);
  const handoff = conv(cap).getByRole("link", {
    name: "Open accepted agreement",
    exact: true,
  });
  assert.equal(
    new URL(await handoff.getAttribute("href"), origin).searchParams.get("id"),
    agreement.id,
  );
  await handoff.click();
  await conv(cap).waitFor();
  assert.equal(
    (await api(cap, `messages?agreementId=${agreement.id}`)).data.length,
    0,
  );
  await open(cap, acceptedApp.id);
  assert.equal(await conv(cap).locator("[data-message-id]").count(), 2);
  await audit(cap, "accepted-discussion");
  record(
    "Invited sends work; accepted read-only handoff targets exact agreement; old messages stay in application",
  );
  for (const [app, commit, label] of [
    [lossApp, true, "committed"],
    [absentApp, false, "no-record"],
  ]) {
    await open(cap, app.id);
    let captured;
    await cap.route("**/api/v1/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      captured = {
        key: route.request().headers()["idempotency-key"],
        body: route.request().postData(),
      };
      if (commit) {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
      }
      await route.abort("failed");
    });
    await cap
      .getByLabel("Message", { exact: true })
      .fill("R10 " + label + " exact recovery");
    await button(cap, "Send message").click();
    await conv(cap)
      .getByRole("heading", { name: "Message outcome not confirmed" })
      .waitFor();
    await ready(cap);
    assert.ok(captured);
    await cap.unroute("**/api/v1/messages");
    await market.withdrawApplication(applicant.id, app.id, {}, key());
    await refresh(cap);
    assert.equal(await button(cap, "Recover same message").isEnabled(), true);
    let replay;
    cap.on("request", function listener(r) {
      if (r.url().endsWith("/api/v1/messages") && r.method() === "POST") {
        replay = { key: r.headers()["idempotency-key"], body: r.postData() };
        cap.off("request", listener);
      }
    });
    await button(cap, "Recover same message").click();
    if (commit) {
      await conv(cap)
        .getByText(
          "Message confirmed. The original request was recovered without sending a duplicate.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await cap.getByLabel("Message", { exact: true }).inputValue(),
        "",
      );
    } else {
      await conv(cap)
        .getByText(
          "Message not sent. This application discussion is closed. Your draft is saved here; it has not been moved or sent elsewhere.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await cap.getByLabel("Message", { exact: true }).inputValue(),
        "R10 no-record exact recovery",
      );
      assert.equal(await button(cap, "Recover same message").count(), 0);
    }
    await ready(cap);
    assert.deepEqual(replay, captured);
    assert.equal(
      (await api(cap, `messages?applicationId=${app.id}`)).data.length,
      commit ? 1 : 0,
    );
    expectedFaults.push({
      label,
      kind: "request/response abort then ordinary withdrawal",
      exactReplay: true,
    });
    record(
      `Lost ${label} request: ordinary closure and exact replay ${commit ? "confirmed once" : "typed refusal retains draft"}`,
    );
  }
  // Current permissions change with no concurrency/lock pause or diagnostic reproduction.
  await open(member, reapplied.id);
  await send(member, "R10 current permission record");
  await withFixture((c) =>
    c.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1", [
      peer.id,
    ]),
  );
  await refresh(member);
  await conv(member)
    .getByRole("heading", { name: "Application discussion is read-only" })
    .waitFor();
  assert.equal(await button(member, "Send message").isEnabled(), false);
  assert.equal(await conv(member).locator("[data-message-id]").count(), 1);
  await withFixture((c) =>
    c.query("UPDATE campus.users SET account_status='active' WHERE id=$1", [
      peer.id,
    ]),
  );
  await withFixture((c) =>
    c.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [peer.id],
    ),
  );
  await member.reload();
  await ready(member);
  assert.equal(
    await member
      .getByRole("heading", { name: primaryTask.title, exact: true })
      .count(),
    0,
  );
  assert.equal(
    await member
      .getByRole("link", {
        name: "Open bounty and available actions",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(
    (await api(member, `applications/${reapplied.id}`)).data.task,
    null,
  );
  assert.equal(await button(member, "Send message").isEnabled(), false);
  assert.equal(await conv(member).locator("[data-message-id]").count(), 1);
  record(
    "Restricted and expired readers retain private history with current send denial and no inaccessible title",
  );
  await withFixture((c) =>
    c.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [
      peer.id,
    ]),
  );
  await button(member, "Refresh messages").click();
  await member.getByRole("alert").first().waitFor();
  assert.equal(await member.locator("[data-message-id]").count(), 0);
  assert.equal(await member.getByLabel("Message", { exact: true }).count(), 0);
  record(
    "Stale open page suppresses messages, participants and draft after current locked denial",
  );
  // Stale application reads cannot repopulate after unmount/route change.
  await open(cap, otherApp.id);
  let release;
  const gate = new Promise((r) => (release = r));
  let enteredResolve;
  const entered = new Promise((r) => (enteredResolve = r));
  await cap.route("**/api/v1/conversations?*", async (route) => {
    const response = await route.fetch();
    enteredResolve();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await button(cap, "Refresh messages").click();
  await entered;
  assert.equal(await cap.locator("[data-message-id]").count(), 0);
  await cap.goto(`${origin}/?view=workspace&tab=applications`);
  release();
  await cap.unroute("**/api/v1/conversations?*");
  assert.equal(await conv(cap).count(), 0);
  record(
    "Pending application refresh hides stale private content and late read cannot repopulate a different route",
  );
  assert.deepEqual(errors, []);
  console.log("COMPLETE");
})()
  .catch((e) => {
    errors.push(e.stack);
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (store) await store.close();
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          run,
          checks,
          audits,
          errors,
          expectedFaults,
          proof:
            "Synthetic local real database/API/browser; fixture sessions exclude email delivery; response faults explicit. No forced revocation, paused locks, legacy backend suite, payment or deployment.",
        },
        null,
        2,
      ),
    );
    console.log("Evidence " + output);
  });
