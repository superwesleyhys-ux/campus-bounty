// Local synthetic regression for the sealed Round 7 final findings. No external effects.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  origin,
  button,
  seedPeople,
  withFixture,
  fixtureSessionLogin,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round7/final-fixes",
  `browser-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  pageErrors = [],
  pages = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS: ${name}`);
};
async function api(p, route, body) {
  return p.evaluate(
    async ({ route, body, key }) => {
      const r = await fetch(
        `/api/v1/${route}`,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": key,
              },
              body: JSON.stringify(body),
            },
      );
      const data = await r.json();
      if (!r.ok) throw Error(`${r.status} ${data.detail}`);
      return data;
    },
    { route, body, key: randomUUID() },
  );
}
const taskBody = (title) => ({
  title,
  category: "Writing",
  description: "Local synthetic final repair validation.",
  rewardCents: 2000,
  milestones: [1, 2].map((n) => ({
    title: `Part ${n}`,
    amountCents: 1000,
    deliverable: "Three clear steps.",
    acceptanceCriteria: "Name the location and contact.",
  })),
});
const panel = (p, n) =>
  p
    .locator(".cb-fulfillment-milestone")
    .filter({ has: p.getByRole("heading", { name: new RegExp(`^${n}\\. `) }) });
async function openAgreement(p, id) {
  await p.goto(
    `${origin}/?view=workspace&tab=agreements&resource=agreement&id=${id}`,
  );
  await p.locator(".cb-fulfillment-milestone").first().waitFor();
  await p.waitForFunction(() =>
    Array.from(document.querySelectorAll(".cb-fulfillment-milestone")).every(
      (el) => !el.textContent.includes("Loading milestone and review history"),
    ),
  );
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const browser = await chromium.launch({ headless: true });
  try {
    const people = await seedPeople([
      "Final fix publisher",
      "Final fix participant",
      "Final fix outsider",
      "Final fix frozen member",
    ]);
    for (const person of people) {
      const p = await (
        await browser.newContext({
          locale: "en-GB",
          timezoneId: "America/Los_Angeles",
        })
      ).newPage();
      p.on("pageerror", (e) => pageErrors.push(e.message));
      await fixtureSessionLogin(p, person);
      pages.push(p);
    }
    const [owner, member, outsider, peer] = pages;
    const task = await api(
      owner,
      "tasks",
      taskBody(`Final repair collaboration ${run}`),
    );
    const application = await api(member, `tasks/${task.id}/applications`, {
      proposal: "I will prepare the agreed steps.",
    });
    await api(owner, `applications/${application.id}/invitation`, {});
    const signed = await api(
      member,
      `applications/${application.id}/acceptance`,
      {},
    );
    await withFixture((c) =>
      c.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [
        signed.id,
      ]),
    );
    const agreement = await api(member, `agreements/${signed.id}`);
    for (const m of agreement.milestones)
      await api(member, `milestones/${m.id}/submissions`, {
        content:
          "1. Meet at the library. 2. Confirm time. 3. Ask the library help desk.",
        expectedVersion: m.version,
        expectedRevision: m.revision,
      });
    await openAgreement(member, signed.id);
    // Keep a real unsent draft in the participant page while the publisher reviews.
    await panel(member, 1)
      .getByLabel("Revised deliverable", { exact: true })
      .fill("Preserved unsent draft after partner review.");
    const unknownMilestone = agreement.milestones[1].id;
    const workEndpoint = `**/api/v1/milestones/${unknownMilestone}/submissions`;
    const workRequests = [];
    member.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/milestones/${unknownMilestone}/submissions`)
      )
        workRequests.push({
          key: r.headers()["idempotency-key"],
          body: r.postDataJSON(),
        });
    });
    await member.route(workEndpoint, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      await route.abort("failed");
    });
    await panel(member, 2)
      .getByLabel("Revised deliverable", { exact: true })
      .fill("Second version committed with response deliberately lost.");
    await button(panel(member, 2), "Submit new version").click();
    await button(panel(member, 2), "Retry same request").waitFor();
    await member.unroute(workEndpoint);
    const pendingWorkStorage = `campus:fulfillment-request:${people[1].id}:${unknownMilestone}`;
    const pendingWork = await member.evaluate(
      (k) => JSON.parse(sessionStorage.getItem(k)),
      pendingWorkStorage,
    );
    assert.equal(pendingWork.key, workRequests[0].key);
    await openAgreement(owner, signed.id);
    for (const n of [1, 2]) {
      await panel(owner, n).getByRole("checkbox").check();
      await panel(owner, n)
        .getByRole("button", { name: /^Accept version/ })
        .click();
      await panel(owner, n)
        .getByText(/^accepted$/i)
        .waitFor();
    }
    await owner
      .getByText("Agreement completed: every milestone has been accepted.", {
        exact: false,
      })
      .waitFor();
    for (const n of [1, 2]) {
      await button(panel(member, n), "Refresh milestone").click();
      await panel(member, n)
        .getByText(/^accepted$/i)
        .waitFor();
    }
    await member.screenshot({
      path: path.join(output, "participant-after-milestone-refresh.png"),
      fullPage: true,
    });
    await member
      .locator(".cb-heading")
      .getByText(/^completed$/i)
      .waitFor({ timeout: 5000 });
    await member
      .getByText("Agreement completed: every milestone has been accepted.", {
        exact: false,
      })
      .waitFor();
    await panel(member, 1)
      .getByText("Saved unsent draft", { exact: true })
      .click();
    await panel(member, 1)
      .getByText("Preserved unsent draft after partner review.", {
        exact: true,
      })
      .waitFor();
    assert.match(
      await member.locator("main").innerText(),
      /no funds were transferred or settled here/,
    );
    await button(panel(member, 2), "Retry same request").waitFor();
    assert.deepEqual(
      await member.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        pendingWorkStorage,
      ),
      pendingWork,
    );
    await button(panel(member, 2), "Retry same request").click();
    await panel(member, 2)
      .getByText(/Your earlier submission was confirmed/)
      .waitFor();
    assert.equal(workRequests.length, 2);
    assert.deepEqual(workRequests[0], workRequests[1]);
    assert.equal(
      await member.evaluate(
        (k) => sessionStorage.getItem(k),
        pendingWorkStorage,
      ),
      null,
    );
    fs.writeFileSync(
      path.join(output, "aggregate-pending-proof.json"),
      JSON.stringify(
        {
          milestoneId: unknownMilestone,
          workRequests,
          pendingRetainedAcrossCompletion: true,
          recovered: true,
        },
        null,
        2,
      ),
    );
    record(
      "D1: two real browser roles; participant remains on detail while publisher accepts all; milestone refresh updates aggregate completion, preserves unsent draft and unknown request, then replays original work body/key",
    );

    // Same deterministic non-US browser locale on both surfaces must produce the existing US detail format.
    const detailDates = await member
      .locator(".cb-deliverable time")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          shown: n.textContent,
          date: n.dateTime,
          expected: new Date(n.dateTime).toLocaleString("en-US"),
          browser: new Date(n.dateTime).toLocaleString(),
        })),
      );
    assert.ok(detailDates.length > 0);
    for (const d of detailDates) {
      assert.equal(d.shown, d.expected);
      assert.notEqual(d.shown, d.browser);
    }
    await owner.goto(`${origin}/?view=notifications`);
    await owner.locator("[data-notification-id]").first().waitFor();
    const notificationDates = await owner
      .locator("[data-notification-id] time")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          shown: n.textContent,
          date: n.dateTime,
          expected: new Date(n.dateTime).toLocaleString("en-US"),
          browser: new Date(n.dateTime).toLocaleString(),
        })),
      );
    assert.ok(notificationDates.length > 0);
    for (const d of notificationDates) {
      assert.equal(d.shown, d.expected);
      assert.notEqual(d.shown, d.browser);
    }
    fs.writeFileSync(
      path.join(output, "date-format.json"),
      JSON.stringify(
        {
          locale: "en-GB",
          timezone: "America/Los_Angeles",
          detailDates,
          notificationDates,
        },
        null,
        2,
      ),
    );
    record(
      "P3: notification and detail timestamps match explicit en-US under deterministic en-GB browser / America-Los_Angeles timezone",
    );

    // Commit a read, lose only the response, retain A pending while visiting B in the same document.
    const aCookies = await owner.context().cookies(),
      bCookies = await outsider.context().cookies();
    const beforeInbox = await api(owner, "notifications");
    const unknownId = beforeInbox.items.find((n) => !n.readAt).id;
    const endpoint = `**/api/v1/notifications/${unknownId}/read`,
      keys = [];
    let originalReadAt;
    owner.on("request", (r) => {
      if (r.url().endsWith(`/notifications/${unknownId}/read`))
        keys.push(r.headers()["idempotency-key"]);
    });
    await owner.route(endpoint, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      originalReadAt = (await response.json()).readAt;
      await route.abort("failed");
    });
    await owner
      .locator(`[data-notification-id="${unknownId}"]`)
      .getByRole("button", { name: "Mark read", exact: true })
      .click();
    await button(owner, "Retry read request").waitFor();
    await owner.unroute(endpoint);
    const pendingKey = `campus:notification-read:${people[0].id}`;
    const pending = await owner.evaluate(
      (k) => JSON.parse(sessionStorage.getItem(k)),
      pendingKey,
    );
    assert.equal(Object.keys(pending).length, 1);
    assert.equal(pending[unknownId], keys[0]);
    assert.ok(originalReadAt);
    const switchAccount = async (cookies) => {
      await owner.context().clearCookies();
      await owner.context().addCookies(cookies);
      await owner.evaluate(() =>
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "campus:auth-version",
            newValue: crypto.randomUUID(),
          }),
        ),
      );
    };
    await switchAccount(bCookies);
    await owner.getByText(people[2].name, { exact: true }).waitFor();
    await owner
      .getByRole("heading", { name: "No updates on this page", exact: true })
      .waitFor();
    await owner
      .getByRole("link", { name: "Notifications (0 unread)", exact: true })
      .waitFor();
    assert.equal(await owner.locator("[data-notification-id]").count(), 0);
    assert.equal(await button(owner, "Retry read request").count(), 0);
    assert.equal(await owner.getByText(task.title, { exact: true }).count(), 0);
    assert.deepEqual(
      await owner.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        pendingKey,
      ),
      pending,
      "A pending must still be nonempty throughout B visit",
    );
    await owner.screenshot({
      path: path.join(output, "pending-A-while-account-B.png"),
      fullPage: true,
    });
    await switchAccount(aCookies);
    await owner.getByText(people[0].name, { exact: true }).waitFor();
    await button(owner, "Retry read request").waitFor();
    assert.deepEqual(
      await owner.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        pendingKey,
      ),
      pending,
    );
    await button(owner, "Retry read request").click();
    await owner
      .getByText("Marked as read. This does not complete any project action.", {
        exact: true,
      })
      .waitFor();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(
      await owner.evaluate(
        (k) => JSON.parse(sessionStorage.getItem(k)),
        pendingKey,
      ),
      {},
    );
    assert.equal(
      (await api(owner, "notifications")).items.find((n) => n.id === unknownId)
        .readAt,
      originalReadAt,
    );
    fs.writeFileSync(
      path.join(output, "pending-read-proof.json"),
      JSON.stringify(
        {
          unknownId,
          pendingAccountId: people[0].id,
          pendingBeforeSwitch: pending,
          pendingDuringOtherAccount: pending,
          keys,
          originalReadAt,
          recovered: true,
        },
        null,
        2,
      ),
    );
    record(
      "M1: committed response lost with A pending nonempty; B sees no A list/count/recovery; return to A recovers original idempotency key and readAt",
    );

    // Build genuine application history beyond the pre-existing list cap using the same local business module.
    let team = await api(member, "teams", {
      name: `Final history team ${run}`,
      context: {
        purpose: "Write local guide",
        activities: "Review local text",
        timeCommitment: "One hour",
        projectContext: "",
      },
    });
    team = await api(member, `teams/${team.id}/invitations`, {
      expectedRevision: team.revision,
      userId: people[3].id,
    });
    team = await api(peer, `teams/${team.id}/membership`, {
      expectedRevision: team.revision,
    });
    team = await api(member, `teams/${team.id}/invitations`, {
      expectedRevision: team.revision,
      userId: people[2].id,
    });
    team = await api(
      member,
      `teams/${team.id}/members/${people[2].id}/revoke`,
      { expectedRevision: team.revision },
    );
    const historyTask = await api(
      owner,
      "tasks",
      taskBody(`Campus private old target ${run}`),
    );
    const old = await api(member, `tasks/${historyTask.id}/applications`, {
      proposal: "EXACT OLD APPLICATION TARGET",
      teamId: team.id,
    });
    await api(peer, `applications/${old.id}/consent`, {});
    await api(owner, `applications/${old.id}/invitation`, {});
    await api(member, `applications/${old.id}/withdrawal`, {});
    await api(peer, `teams/${team.id}/membership/leave`, {
      expectedRevision: team.revision,
    });
    const { localConfig, connectionString } =
      await import("../scripts/backend-local.mjs");
    const { createStore } = await import("../backend/db/store.mjs");
    const { createMarket } = await import("../backend/modules/market.mjs");
    const fixture = JSON.parse(
      fs.readFileSync(".data/backend/interaction/fixture.json", "utf8"),
    );
    assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
    const urls = Object.fromEntries(
      ["app", "auth", "worker"].map((role) => {
        const url = connectionString(localConfig(), role, fixture.database);
        assert.equal(new URL(url).hostname, "127.0.0.1");
        return [role, url];
      }),
    );
    const store = createStore(urls),
      market = createMarket(store);
    try {
      for (let i = 0; i < 100; i++) {
        const next = await market.apply(
          people[1].id,
          historyTask.id,
          { proposal: `Newer final repair history ${i}` },
          randomUUID(),
        );
        await market.withdrawApplication(
          people[1].id,
          next.id,
          {},
          randomUUID(),
        );
      }
    } finally {
      await store.close();
    }
    for (const person of [people[0], people[1], people[3]])
      await withFixture((c) =>
        c.query(
          "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
          [person.id],
        ),
      );
    async function findNotification(p, kind) {
      await p.goto(`${origin}/?view=notifications`);
      let notification;
      for (let n = 0; n < 20; n++) {
        await p.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Activity updates"]')
              ?.getAttribute("aria-busy") === "false",
        );
        // Read exact page ids via rendered links; target id in the href is authoritative.
        const link = p.locator(`[data-notification-id]`).filter({
          has: p.getByRole("link", { name: "Open update", exact: true }),
        });
        for (let i = 0; i < (await link.count()); i++) {
          const el = link.nth(i),
            href = await el
              .getByRole("link", { name: "Open update", exact: true })
              .getAttribute("href");
          const title = await el.getByRole("heading").innerText();
          if (href.includes(`id=${old.id}`) && title === kind) {
            notification = {
              id: await el.getAttribute("data-notification-id"),
              href,
            };
            await el
              .getByRole("link", { name: "Open update", exact: true })
              .click();
            break;
          }
        }
        if (notification || (await button(p, "Next page").isDisabled())) break;
        await button(p, "Next page").click();
      }
      assert.ok(notification, `Exact old ${kind} notification is reachable`);
      await p.locator(`#application-${old.id}`).waitFor();
      await p
        .getByText("EXACT OLD APPLICATION TARGET", { exact: true })
        .waitFor();
      assert.equal(
        await p.getByText(historyTask.title, { exact: true }).count(),
        0,
      );
      assert.equal(
        await p
          .getByRole("link", {
            name: "Open bounty and available actions",
            exact: true,
          })
          .count(),
        0,
      );
      const dto = await api(p, `applications/${old.id}`);
      assert.equal(dto.task, null);
      assert.match(p.url(), /resource=application/);
      return notification;
    }
    assert.equal((await api(member, "applications")).length, 100);
    assert.ok(
      !(await api(member, "applications")).some((a) => a.id === old.id),
    );
    const receivedTarget = await findNotification(owner, "New application");
    const withdrawnTarget = await findNotification(
      owner,
      "Application withdrawn",
    );
    const applicantTarget = await findNotification(
      member,
      "Task invitation received",
    );
    const peerTarget = await findNotification(peer, "Task invitation received");
    await peer.screenshot({
      path: path.join(output, "expired-frozen-member-single-history.png"),
      fullPage: true,
    });
    await peer.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const violations = await peer.evaluate(async () =>
      (await axe.run()).violations.map((v) => ({ id: v.id, impact: v.impact })),
    );
    assert.deepEqual(violations, []);
    const widths = [];
    for (const width of [320, 768, 1024, 1440]) {
      await peer.setViewportSize({ width, height: 950 });
      assert.ok(
        await peer.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await peer.screenshot({
        path: path.join(output, `application-history-${width}.png`),
        fullPage: true,
      });
      widths.push(width);
    }
    fs.writeFileSync(
      path.join(output, "application-accessibility.json"),
      JSON.stringify({ widths, violations }, null, 2),
    );
    record(
      "I1: expired publisher opens received and withdrawn exact old targets; expired applicant opens target absent from latest 100; expired frozen member retains historical access after team leave; campus title/id absent",
    );
    const status = async (p, id) =>
      p.evaluate(async (id) => {
        const r = await fetch(`/api/v1/applications/${id}`);
        return {
          status: r.status,
          body: await r.json(),
          cache: r.headers.get("cache-control"),
        };
      }, id);
    assert.equal(
      (await status(outsider, old.id)).status,
      404,
      "Revoked team invitee is not an application member",
    );
    // Explicit permission-loss fixture; do not alter a sealed account or invent a public revocation API.
    await withFixture((c) =>
      c.query(
        "DELETE FROM campus.application_members WHERE application_id=$1 AND user_id=$2",
        [old.id, people[3].id],
      ),
    );
    await button(peer, "Refresh application").click();
    await peer.getByText("Resource not found.", { exact: true }).waitFor();
    assert.equal(
      await peer
        .getByText("EXACT OLD APPLICATION TARGET", { exact: true })
        .count(),
      0,
    );
    assert.equal((await status(peer, old.id)).status, 404);
    await withFixture((c) =>
      c.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [
        people[1].id,
      ]),
    );
    assert.equal((await status(member, old.id)).status, 401);
    fs.writeFileSync(
      path.join(output, "single-target-proof.json"),
      JSON.stringify(
        {
          oldApplicationId: old.id,
          receivedTarget,
          withdrawnTarget,
          applicantTarget,
          peerTarget,
          latestListSize: 100,
          unauthorized: 404,
          revokedSnapshot: 404,
          locked: 401,
        },
        null,
        2,
      ),
    );
    record(
      "I1 HTTP/UI: revoked invitee and removed authorization row denied 404, refresh clears visible private detail, locked session denied 401",
    );
    assert.deepEqual(pageErrors, []);
  } catch (e) {
    fs.writeFileSync(path.join(output, "failure.txt"), e.stack);
    for (let i = 0; i < pages.length; i++)
      await pages[i]
        .screenshot({
          path: path.join(output, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
    throw e;
  } finally {
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          run,
          checks,
          pageErrors,
          scope:
            "Local synthetic fixture; auth setup and simulated funding exclude OTP delivery and payment.",
        },
        null,
        2,
      ),
    );
    await browser.close();
    console.log(output);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
