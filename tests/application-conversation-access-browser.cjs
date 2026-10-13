// Remaining Task 3 checks resume exact known synthetic fixtures, not prior passed suites.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { randomUUID: key } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  withFixture,
  fixtureSessionLogin,
  origin,
  button,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round10",
  `task-3-access-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const seed = JSON.parse(fs.readFileSync(process.env.R10_RESUME_FIXTURE));
const checks = [],
  errors = [];
const record = (n) => {
  checks.push(n);
  console.log("PASS " + n);
};
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
const open = async (p, id) => {
  await p.goto(
    `${origin}/?view=workspace&tab=applications&resource=application&id=${id}`,
  );
  await ready(p);
};
let browser, store;
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
    ["app", "auth", "worker"].map((r) => {
      const u = connectionString(localConfig(), r, fixture.database);
      assert.equal(new URL(u).hostname, "127.0.0.1");
      return [r, u];
    }),
  );
  store = createStore(urls);
  const market = createMarket(store);
  const [owner, applicant, peer] = seed.people;
  const reapplied = (
    await withFixture((c) =>
      c.query(
        "SELECT id FROM campus.applications WHERE task_id=$1 AND applicant_id=$2 AND state='applied'",
        [seed.primaryTask.id, applicant.id],
      ),
    )
  ).rows[0];
  assert.ok(reapplied);
  browser = await chromium.launch({ headless: true });
  const member = await browser.newPage(),
    cap = await browser.newPage();
  for (const p of [member, cap]) p.on("pageerror", (e) => errors.push(e.stack));
  await fixtureSessionLogin(member, peer);
  await fixtureSessionLogin(cap, applicant);
  await open(member, reapplied.id);
  assert.equal(
    await member
      .getByRole("heading", { name: seed.primaryTask.title, exact: true })
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
  assert.equal(await button(member, "Send message").isEnabled(), false);
  assert.equal(await conv(member).locator("[data-message-id]").count(), 1);
  assert.equal(
    await member.evaluate(
      async (id) =>
        (await (await fetch("/api/v1/applications/" + id)).json()).task,
      reapplied.id,
    ),
    null,
  );
  record(
    "Expired current reader: authorized private history retained; catalog heading/action absent; backend task null",
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
  assert.equal(
    await member
      .getByRole("list", { name: "Conversation participants" })
      .count(),
    0,
  );
  record(
    "Ordinary current locked-account refresh suppresses stale history, roster and draft",
  );
  await open(cap, seed.otherApp.id);
  let release, enteredResolve;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (enteredResolve = r));
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
    "In-flight refresh suppresses private content; late read cannot repopulate another route",
  );
  const task = await market.publishTask(
    owner.id,
    {
      title: "R10 roster and current access " + run,
      category: "Research",
      description: "Synthetic roster pagination",
      rewardCents: 100,
      milestones: [
        { title: "Evidence", amountCents: 100, deliverable: "Local record" },
      ],
    },
    key(),
  );
  const app = await market.apply(
    applicant.id,
    task.id,
    { proposal: "Synthetic roster fixture" },
    key(),
  );
  await withFixture((c) =>
    c.query(
      "WITH people AS (INSERT INTO campus.users(display_name) SELECT 'R10 Proposed '||n FROM generate_series(1,112)n RETURNING id) INSERT INTO campus.application_members(application_id,user_id,confirmed) SELECT $1,id,false FROM people",
      [app.id],
    ),
  );
  await store.as(owner.id, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,application_id,body) SELECT $1,$2,'R10 roster history '||n FROM generate_series(1,61)n",
      [owner.id, app.id],
    ),
  );
  await open(cap, app.id);
  assert.equal(
    await conv(cap)
      .getByRole("list", { name: "Conversation participants" })
      .locator("li")
      .count(),
    100,
  );
  await button(cap, "Load more participants").click();
  await conv(cap)
    .getByText("More participants loaded.", { exact: true })
    .waitFor();
  assert.equal(
    await conv(cap)
      .getByRole("list", { name: "Conversation participants" })
      .locator("li")
      .count(),
    114,
  );
  assert.equal(await button(cap, "Load more participants").count(), 0);
  assert.doesNotMatch(
    await conv(cap)
      .getByRole("list", { name: "Conversation participants" })
      .textContent(),
    /Signed participant/,
  );
  record(
    "114-person frozen application roster fully paginates with accurate proposed roles",
  );
  await withFixture((c) =>
    c.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [applicant.id],
    ),
  );
  await button(cap, "Load older messages").click();
  await conv(cap)
    .getByText("Older messages loaded. Your reading position is preserved.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await cap.getByRole("heading", { name: task.title, exact: true }).count(),
    0,
  );
  assert.equal(
    await cap
      .getByRole("link", {
        name: "Open bounty and available actions",
        exact: true,
      })
      .count(),
    0,
  );
  assert.equal(await button(cap, "Send message").isEnabled(), false);
  record(
    "Fresh history-page verification suppresses previously visible catalog title after affiliation expiry",
  );
  await withFixture((c) =>
    c.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '180 days' WHERE user_id=$1",
      [applicant.id],
    ),
  );
  await cap.reload();
  await ready(cap);
  let sent;
  await cap.route("**/api/v1/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent = {
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    };
    assert.equal((await route.fetch()).status(), 201);
    await route.abort("failed");
  });
  await cap
    .getByLabel("Message", { exact: true })
    .fill("R10 generic denial pending");
  await button(cap, "Send message").click();
  await conv(cap)
    .getByRole("heading", { name: "Message outcome not confirmed" })
    .waitFor();
  await ready(cap);
  await cap.unroute("**/api/v1/messages");
  const storage = `campus:conversation:${applicant.id}:applicationId:${app.id}`;
  const before = await cap.evaluate(
    (k) => JSON.parse(sessionStorage.getItem(k)),
    storage,
  );
  // Inject a generic denied recovery response; it is explicitly not evidence of no record.
  await cap.route("**/api/v1/messages", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/problem+json",
      body: JSON.stringify({
        code: "account_restricted",
        detail: "Synthetic generic recovery denial",
      }),
    }),
  );
  await button(cap, "Recover same message").click();
  await conv(cap)
    .getByText("Synthetic generic recovery denial", { exact: true })
    .waitFor();
  await ready(cap);
  assert.deepEqual(
    await cap.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), storage),
    before,
  );
  assert.equal(await button(cap, "Recover same message").count(), 1);
  await cap.unroute("**/api/v1/messages");
  let replay;
  cap.once("request", () => {});
  const listener = (r) => {
    if (r.url().endsWith("/api/v1/messages") && r.method() === "POST")
      replay = { key: r.headers()["idempotency-key"], body: r.postData() };
  };
  cap.on("request", listener);
  await button(cap, "Recover same message").click();
  await conv(cap)
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
      { exact: true },
    )
    .waitFor();
  await ready(cap);
  assert.deepEqual(replay, sent);
  record(
    "Generic 403 preserves ambiguous exact request; later authorized replay confirms original once",
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
          errors,
          proof:
            "Synthetic loopback fixtures; ordinary current-account changes only, no concurrent lock or revocation diagnostic. Generic403 explicitly injected; later receipt real.",
        },
        null,
        2,
      ),
    );
    console.log("Evidence " + output);
  });
