// I1 focused ordinary authority synchronization. No backend suites or lock diagnostics.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { randomUUID: key } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  seedPeople,
  withFixture,
  fixtureSessionLogin,
  origin,
  button,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round10",
  `task-3-i1-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  failures = [],
  observations = [],
  pageErrors = [];
let browser, store;
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
async function check(name, fn) {
  if (process.env.I1_CASE_FILTER && !name.includes(process.env.I1_CASE_FILTER))
    return;
  try {
    await fn();
    checks.push(name);
    console.log("PASS " + name);
  } catch (e) {
    failures.push({ name, error: e.stack });
    console.error("FAIL " + name + "\n" + e.stack);
  }
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
  store = createStore(
    Object.fromEntries(
      ["app", "auth", "worker"].map((role) => {
        const u = connectionString(localConfig(), role, fixture.database);
        assert.equal(new URL(u).hostname, "127.0.0.1");
        return [role, u];
      }),
    ),
  );
  const market = createMarket(store);
  const people = await seedPeople(["I1 Publisher", "I1 Applicant"]);
  const [owner, applicant] = people;
  async function make(label) {
    const task = await market.publishTask(
      owner.id,
      {
        title: `I1 ${label} ${run}`,
        category: "Research",
        description: "Synthetic discovery authority",
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
      { proposal: "Synthetic private proposal" },
      key(),
    );
    const message = await market.sendMessage(
      owner.id,
      { applicationId: app.id, body: "I1 searchable exact message" },
      key(),
    );
    return { task, app, message };
  }
  const primary = await make("primary"),
    other = await make("other"),
    isolated = await make("isolated");
  browser = await chromium.launch({ headless: true });
  const p = await browser.newPage();
  p.on("pageerror", (e) => pageErrors.push(e.message));
  await fixtureSessionLogin(p, applicant);
  const open = async (s, extra = "") => {
    await p.goto(
      `${origin}/?view=workspace&tab=applications&resource=application&id=${s.app.id}${extra}`,
    );
    await ready(p);
  };
  const reset = () =>
    withFixture(async (c) => {
      await c.query(
        "UPDATE campus.users SET account_status='active' WHERE id=$1",
        [applicant.id],
      );
      await c.query(
        "UPDATE campus.affiliations SET valid_until=now()+interval '180 days' WHERE user_id=$1",
        [applicant.id],
      );
    });
  async function search() {
    await p
      .getByRole("searchbox", { name: "Search this conversation", exact: true })
      .fill("searchable exact");
    await button(p, "Search messages").click();
    await p.locator("[data-search-message-id]").waitFor();
  }
  const state = async () => ({
    titleVisible:
      (await p
        .getByRole("heading", { name: primary.task.title, exact: true })
        .count()) > 0,
    bountyAction:
      (await p
        .getByRole("link", {
          name: "Open bounty and available actions",
          exact: true,
        })
        .count()) > 0,
    sendEnabled: await button(p, "Send message").isEnabled(),
    history: await p.locator("[data-message-id]").count(),
  });
  await check(
    "Expiry followed only by search removes catalog and send authority while private search/draft remain",
    async () => {
      await reset();
      await open(primary);
      await p
        .getByLabel("Message", { exact: true })
        .fill("I1 retained local draft");
      await withFixture((c) =>
        c.query(
          "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
          [applicant.id],
        ),
      );
      await search();
      const observed = await state();
      observations.push({ case: "expiry-search", ...observed });
      assert.equal(observed.titleVisible, false);
      assert.equal(observed.bountyAction, false);
      assert.equal(observed.sendEnabled, false);
      assert.equal(observed.history, 1);
      assert.equal(
        await p.getByLabel("Message", { exact: true }).inputValue(),
        "I1 retained local draft",
      );
    },
  );
  await check(
    "Restriction followed only by exact context disables send without denying private context/history",
    async () => {
      await reset();
      await open(primary);
      await search();
      await withFixture((c) =>
        c.query(
          "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
          [applicant.id],
        ),
      );
      await button(p, "Open message in context").click();
      await p
        .locator(
          `[data-context-message-id="${primary.message.id}"][aria-current="true"]`,
        )
        .waitFor();
      const observed = await state();
      observations.push({ case: "restriction-context", ...observed });
      assert.equal(observed.sendEnabled, false);
      assert.equal(observed.history, 1);
      assert.equal(observed.titleVisible, true);
    },
  );
  await check(
    "Ordinary closure then unavailable exact message adopts scope recheck lifecycle without history refresh",
    async () => {
      await reset();
      await open(primary);
      await p.getByLabel("Message", { exact: true }).fill("I1 closed draft");
      await market.withdrawApplication(applicant.id, primary.app.id, {}, key());
      await p.evaluate((m) => {
        const u = new URL(location.href);
        u.searchParams.set("messageId", m);
        history.pushState(null, "", u);
      }, key());
      await conv(p)
        .getByText(
          "This message is unavailable in this conversation. Return to the conversation or search for another message.",
          { exact: true },
        )
        .waitFor();
      const observed = await state();
      observations.push({ case: "closure-missing-context", ...observed });
      assert.equal(observed.sendEnabled, false);
      assert.equal(
        await conv(p)
          .getByRole("heading", { name: "Application discussion is read-only" })
          .count(),
        1,
      );
      assert.equal(
        await p.getByLabel("Message", { exact: true }).inputValue(),
        "I1 closed draft",
      );
      assert.equal(observed.history, 1);
    },
  );
  await check(
    "Discovery authority changes preserve an ambiguous exact request and later real receipt recovery",
    async () => {
      await reset();
      await open(other);
      await p.route("**/api/v1/messages", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        assert.equal((await route.fetch()).status(), 201);
        await route.abort("failed");
      });
      await p
        .getByLabel("Message", { exact: true })
        .fill("I1 pending exact message");
      await button(p, "Send message").click();
      await conv(p)
        .getByRole("heading", { name: "Message outcome not confirmed" })
        .waitFor();
      await ready(p);
      await p.unroute("**/api/v1/messages");
      const storage = `campus:conversation:${applicant.id}:applicationId:${other.app.id}`;
      const before = await p.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        storage,
      );
      await withFixture((c) =>
        c.query(
          "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
          [applicant.id],
        ),
      );
      await search();
      assert.deepEqual(
        await p.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), storage),
        before,
      );
      assert.equal(await button(p, "Recover same message").isEnabled(), false);
      await reset();
      await button(p, "Search messages").click();
      await p.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent.trim() === "Recover same message" && !b.disabled,
        ),
      );
      await button(p, "Recover same message").click();
      await conv(p)
        .getByText(
          "Message confirmed. The original request was recovered without sending a duplicate.",
          { exact: true },
        )
        .waitFor();
    },
  );
  await check(
    "Delayed old discovery me/context observations cannot change another application scope",
    async () => {
      await reset();
      await open(isolated);
      await p
        .getByLabel("Message", { exact: true })
        .fill("I1 isolated scope draft");
      let release, enteredResolve;
      const gate = new Promise((r) => (release = r)),
        entered = new Promise((r) => (enteredResolve = r));
      let intercepted = false;
      await p.route("**/api/v1/me", async (route) => {
        if (intercepted) return route.continue();
        intercepted = true;
        const response = await route.fetch();
        const body = await response.json();
        enteredResolve();
        await gate;
        await route
          .fulfill({
            response,
            json: {
              ...body,
              campus_verified: false,
              account_status: "restricted",
            },
          })
          .catch(() => {});
      });
      await p
        .getByRole("searchbox", {
          name: "Search this conversation",
          exact: true,
        })
        .fill("searchable");
      await button(p, "Search messages").click();
      await entered;
      await p
        .getByRole("link", { name: "Back to workspace", exact: false })
        .click();
      await p.evaluate((id) => {
        const u = new URL(location.href);
        u.searchParams.set("view", "workspace");
        u.searchParams.set("tab", "applications");
        u.searchParams.set("resource", "application");
        u.searchParams.set("id", id);
        history.pushState(null, "", u);
      }, other.app.id);
      await ready(p);
      assert.equal(
        await p.getByLabel("Message", { exact: true }).inputValue(),
        "",
      );
      await p
        .getByLabel("Message", { exact: true })
        .fill("I1 other fresh draft");
      release();
      await p.unroute("**/api/v1/me");
      await p.waitForTimeout(150);
      assert.equal(await button(p, "Send message").isEnabled(), true);
      assert.equal(
        await p
          .getByRole("heading", { name: other.task.title, exact: true })
          .count(),
        1,
      );
      assert.equal(
        await p.getByLabel("Message", { exact: true }).inputValue(),
        "I1 other fresh draft",
      );
    },
  );
  await check(
    "Delayed missing-message scope recheck cannot close a different application",
    async () => {
      await reset();
      await open(primary);
      let release, enteredResolve, deliveredResolve;
      const gate = new Promise((r) => (release = r)),
        entered = new Promise((r) => (enteredResolve = r)),
        delivered = new Promise((r) => (deliveredResolve = r));
      await p.route(
        `**/api/v1/conversations?applicationId=${primary.app.id}`,
        async (route) => {
          const response = await route.fetch();
          enteredResolve();
          await gate;
          await route.fulfill({ response }).catch(() => {});
          deliveredResolve();
        },
      );
      await p.evaluate((m) => {
        const u = new URL(location.href);
        u.searchParams.set("messageId", m);
        history.pushState(null, "", u);
      }, key());
      await entered;
      await p.evaluate((id) => {
        const u = new URL(location.href);
        u.searchParams.set("id", id);
        u.searchParams.delete("messageId");
        history.pushState(null, "", u);
      }, isolated.app.id);
      await ready(p);
      release();
      await delivered;
      await p.unroute(
        `**/api/v1/conversations?applicationId=${primary.app.id}`,
      );
      assert.equal(await button(p, "Send message").isEnabled(), true);
      assert.equal(
        await p
          .getByRole("heading", { name: isolated.task.title, exact: true })
          .count(),
        1,
      );
      assert.equal(
        await conv(p)
          .getByRole("heading", { name: "Application discussion is read-only" })
          .count(),
        0,
      );
    },
  );
  await check(
    "Superseded same-scope search cannot overwrite newer account authority",
    async () => {
      await reset();
      await open(isolated);
      let release, enteredResolve, deliveredResolve;
      const gate = new Promise((r) => (release = r)),
        entered = new Promise((r) => (enteredResolve = r)),
        delivered = new Promise((r) => (deliveredResolve = r));
      let first = true;
      await p.route("**/api/v1/me", async (route) => {
        if (!first) return route.continue();
        first = false;
        const response = await route.fetch(),
          body = await response.json();
        enteredResolve();
        await gate;
        await route
          .fulfill({
            response,
            json: {
              ...body,
              campus_verified: false,
              account_status: "restricted",
            },
          })
          .catch(() => {});
        deliveredResolve();
      });
      await p
        .getByRole("searchbox", {
          name: "Search this conversation",
          exact: true,
        })
        .fill("searchable");
      await button(p, "Search messages").click();
      await entered;
      await p
        .getByRole("searchbox", {
          name: "Search this conversation",
          exact: true,
        })
        .fill("searchable exact");
      await button(p, "Search messages").click();
      await p.locator("[data-search-message-id]").waitFor();
      release();
      await delivered;
      await p.unroute("**/api/v1/me");
      assert.equal(await button(p, "Send message").isEnabled(), true);
      assert.equal(
        await p
          .getByRole("heading", { name: isolated.task.title, exact: true })
          .count(),
        1,
      );
    },
  );
  await check(
    "Fresh discovery me restores authorized pending recovery despite a restricted initial page snapshot",
    async () => {
      await reset();
      const recovery = await make("restored-authority");
      await open(recovery);
      await p.route("**/api/v1/messages", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        assert.equal((await route.fetch()).status(), 201);
        await route.abort("failed");
      });
      await p
        .getByLabel("Message", { exact: true })
        .fill("I1 initially restricted recovery");
      await button(p, "Send message").click();
      await conv(p)
        .getByRole("heading", { name: "Message outcome not confirmed" })
        .waitFor();
      await ready(p);
      await p.unroute("**/api/v1/messages");
      const storage = `campus:conversation:${applicant.id}:applicationId:${recovery.app.id}`;
      const before = await p.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        storage,
      );
      await withFixture((c) =>
        c.query(
          "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
          [applicant.id],
        ),
      );
      await p.reload();
      await ready(p);
      assert.equal(await button(p, "Recover same message").isEnabled(), false);
      await reset();
      await search();
      assert.deepEqual(
        await p.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), storage),
        before,
      );
      assert.equal(await button(p, "Recover same message").isEnabled(), true);
      await button(p, "Recover same message").click();
      await conv(p)
        .getByText(
          "Message confirmed. The original request was recovered without sending a duplicate.",
          { exact: true },
        )
        .waitFor();
    },
  );
  assert.deepEqual(pageErrors, []);
})()
  .catch((e) => {
    failures.push({ name: "setup", error: e.stack });
    console.error(e.stack);
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
          failures,
          observations,
          pageErrors,
          proof:
            "Synthetic local ordinary expiry/restriction/withdrawal; explicit lost-response and delayed-response faults; no locks or revocation diagnostic.",
        },
        null,
        2,
      ),
    );
    if (failures.length) process.exitCode = 1;
    console.log("Evidence " + output);
  });
