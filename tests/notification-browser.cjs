// Round 7: real loopback browser + API transitions; explicit response faults test recovery states.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
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
  "docs/evidence/interaction-round7",
  `browser-notifications-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  visualChecks = [],
  pageErrors = [],
  pages = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS: ${name}`);
};
async function api(p, route, body) {
  return p.evaluate(
    async ({ route, body, key }) => {
      const response = await fetch(
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
      const data = await response.json();
      if (!response.ok) throw Error(`${response.status} ${data.detail}`);
      return data;
    },
    { route, body, key: randomUUID() },
  );
}
async function inbox(p) {
  await p.goto(`${origin}/?view=notifications`);
  await p
    .getByRole("heading", { name: "Notifications", exact: true })
    .waitFor();
  await p.waitForFunction(
    () =>
      !document
        .querySelector('[aria-label="Activity updates"]')
        ?.getAttribute("aria-busy")
        ?.includes("true"),
  );
}
async function workspace(p) {
  await p.goto(`${origin}/?view=workspace&tab=agreements`);
  await p.locator(".cb-agreement-card").first().waitFor();
}
async function audit(p, name) {
  await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await p.evaluate(async () =>
    (await axe.run()).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  );
  const widths = [];
  for (const width of [320, 768, 1024, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    const size = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    assert.ok(size.scroll <= size.width, `${name} overflow at ${width}`);
    await p.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
    widths.push(width);
  }
  visualChecks.push({ name, widths, violations });
  assert.deepEqual(violations, [], `${name} axe violations`);
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  await withFixture(async (c) =>
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM campus.schema_migrations WHERE name LIKE '011_%'",
        )
      ).rows[0].n,
      1,
    ),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const people = await seedPeople([
      "Inbox publisher",
      "Inbox participant",
      "Inbox independent user",
    ]);
    for (const person of people) {
      const p = await (await browser.newContext()).newPage();
      p.on("pageerror", (e) => pageErrors.push(e.message));
      await fixtureSessionLogin(p, person);
      pages.push(p);
    }
    const [owner, member, outsider] = pages;
    await inbox(owner);
    await owner
      .getByRole("heading", { name: "No updates on this page" })
      .waitFor();
    await audit(owner, "01-empty");
    const title = `Library guide <strong>plain text</strong> ${run}`;
    const task = await api(owner, "tasks", {
      title,
      category: "Writing",
      description:
        "A local synthetic collaboration to check notification routing and work summaries.",
      rewardCents: 2000,
      milestones: [1, 2].map((n) => ({
        title: `Guide part ${n}`,
        amountCents: 1000,
        deliverable: "A numbered guide with three visitor steps.",
        acceptanceCriteria:
          "Include location, opening time, and a contact point.",
      })),
    });
    const application = await api(member, `tasks/${task.id}/applications`, {
      proposal: "I will write a concise guide with three visitor steps.",
    });
    await button(owner, "Refresh notifications").click();
    await owner
      .getByRole("heading", { name: "New application", exact: true })
      .waitFor();
    let notifications = await api(owner, "notifications");
    const initialId = notifications.items[0].id;
    assert.equal(notifications.unreadCount, 1);
    assert.equal(
      await owner.locator(".cb-notification-context strong").count(),
      0,
    );
    assert.equal(
      await owner.locator(".cb-notification-context").textContent(),
      title,
    );
    await owner
      .locator(`[data-notification-id="${initialId}"]`)
      .getByRole("link", { name: "Open update" })
      .click();
    await owner.locator(`#application-${application.id}`).waitFor();
    assert.equal(
      (await api(owner, "notifications")).unreadCount,
      1,
      "Opening must not mark read",
    );
    await inbox(owner);
    await audit(owner, "02-unread");
    await button(owner, "Mark read").click();
    await owner
      .getByText("Marked as read. This does not complete any project action.", {
        exact: true,
      })
      .waitFor();
    await owner.reload();
    await owner
      .locator(`[data-notification-id="${initialId}"]`)
      .getByText("Read", { exact: true })
      .waitFor();
    assert.equal((await api(owner, "notifications")).unreadCount, 0);
    await button(owner, "Unread").click();
    await owner
      .getByRole("heading", { name: "No unread updates on this page" })
      .waitFor();
    assert.equal(await owner.locator("[data-notification-id]").count(), 0);
    await button(owner, "All updates").click();
    await owner.locator(`[data-notification-id="${initialId}"]`).waitFor();
    assert.equal((await api(outsider, "notifications")).items.length, 0);
    record(
      "Partner application creates visible notification; escaped context label; correct target; explicit read survives reload; unread/all and recipient isolation",
    );
    await api(owner, `applications/${application.id}/invitation`, {});
    // Expired campus membership retains private application history; target omits taskId.
    await withFixture((c) =>
      c.query(
        "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
        [people[1].id],
      ),
    );
    await inbox(member);
    const expired = await api(member, "notifications");
    assert.equal(expired.items[0].target.taskId, undefined);
    await member
      .getByRole("link", { name: "Open update", exact: true })
      .click();
    await member.locator(`#application-${application.id}`).waitFor();
    assert.match(member.url(), /view=workspace/);
    await withFixture((c) =>
      c.query(
        "UPDATE campus.affiliations SET valid_until=now()+interval '180 days' WHERE user_id=$1",
        [people[1].id],
      ),
    );
    await member.reload();
    record(
      "Expired campus membership application target falls back to usable private workspace history",
    );
    const signed = await api(
      member,
      `applications/${application.id}/acceptance`,
      {},
    );
    await workspace(member);
    await member.getByText("Waiting for funding.", { exact: true }).waitFor();
    await withFixture((c) =>
      c.query(
        "UPDATE campus.agreements SET state='active' WHERE id=$1 AND state='awaiting_funding'",
        [signed.id],
      ),
    );
    await workspace(member);
    await member
      .getByText("Your turn: 2 milestones still need initial work.", {
        exact: true,
      })
      .waitFor();
    let agreement = await api(owner, `agreements/${signed.id}`);
    const [m1, m2] = agreement.milestones;
    let submitted = await api(member, `milestones/${m1.id}/submissions`, {
      content: "First version with location and three visitor steps.",
      expectedVersion: m1.version,
      expectedRevision: m1.revision,
    });
    await workspace(owner);
    await owner
      .getByText("Your turn: review 1 submitted draft.", { exact: true })
      .waitFor();
    await audit(owner, "03-publisher-action");
    await api(owner, `milestones/${m1.id}/revision-requests`, {
      submissionId: submitted.submission.id,
      expectedVersion: submitted.milestone.version,
      expectedRevision: submitted.milestone.revision,
      feedback:
        "Add the opening time and contact point required in the agreed criteria.",
    });
    await workspace(member);
    await member
      .getByText("Your turn: changes requested on 1 milestone.", {
        exact: true,
      })
      .waitFor();
    await audit(member, "04-participant-changes");
    agreement = await api(member, `agreements/${signed.id}`);
    for (const milestone of agreement.milestones) {
      submitted = await api(member, `milestones/${milestone.id}/submissions`, {
        content:
          "Three steps, library entrance location, 9 am opening time, and library information desk contact.",
        expectedVersion: milestone.version,
        expectedRevision: milestone.revision,
      });
      await api(owner, `milestones/${milestone.id}/acceptance`, {
        submissionId: submitted.submission.id,
        expectedVersion: submitted.milestone.version,
        expectedRevision: submitted.milestone.revision,
      });
    }
    await workspace(member);
    await member.getByText("Completed.", { exact: true }).waitFor();
    await member
      .getByText("All milestones accepted. No funds were transferred.", {
        exact: false,
      })
      .waitFor();
    await member.goto(`${origin}/?view=bounties&id=${task.id}`);
    await member
      .getByRole("heading", { name: "Recruitment closed", exact: true })
      .waitFor();
    await member.getByRole("link", { name: "Open linked agreement" }).waitFor();
    assert.equal(
      await member
        .getByRole("button", { name: "Send application", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await member
        .getByRole("heading", { name: "What happens next?", exact: true })
        .count(),
      0,
    );
    await audit(member, "05-contracted-completed");
    await member.getByRole("link", { name: "Open linked agreement" }).click();
    await member.getByText(/Agreement completed: every milestone/).waitFor();
    record(
      "Workspace funding, initial work, publisher review, participant changes, completed counts and contracted bounty/linked agreement remain consistent",
    );
    for (let i = 0; i < 24; i++)
      await api(member, "messages", {
        agreementId: signed.id,
        body: `Synthetic local inbox pagination message ${i + 1}.`,
      });
    await inbox(owner);
    const firstIds = await owner
      .locator("[data-notification-id]")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.notificationId));
    assert.equal(firstIds.length, 20);
    await button(owner, "Next page").click();
    await owner.getByText(/unread · Page 2/).waitFor();
    const secondIds = await owner
      .locator("[data-notification-id]")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.notificationId));
    assert.ok(secondIds.length > 0);
    assert.equal(
      secondIds.some((id) => firstIds.includes(id)),
      false,
    );
    await button(owner, "Previous page").click();
    await owner.getByText(/unread · Page 1/).waitFor();
    assert.deepEqual(
      await owner
        .locator("[data-notification-id]")
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.notificationId)),
      firstIds,
    );
    await button(owner, "Unread").click();
    await owner.getByText(/unread · Page 1/).waitFor();
    const unknownId = (await api(owner, "notifications?unread=true")).items[0]
      .id;
    const keys = [];
    owner.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/notifications/${unknownId}/read`)
      )
        keys.push(r.headers()["idempotency-key"]);
    });
    const endpoint = `**/api/v1/notifications/${unknownId}/read`;
    await owner.route(endpoint, async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await owner
      .locator(`[data-notification-id="${unknownId}"]`)
      .getByRole("button", { name: "Mark read" })
      .click();
    await button(owner, "Retry read request").waitFor();
    await audit(owner, "06-read-unknown");
    await owner.unroute(endpoint);
    await owner.reload();
    await button(owner, "Retry read request").waitFor();
    await button(owner, "Unread").click();
    await button(owner, "Retry read request").click();
    await owner
      .getByText("Marked as read. This does not complete any project action.", {
        exact: true,
      })
      .waitFor();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(
      await owner.locator(`[data-notification-id="${unknownId}"]`).count(),
      0,
    );
    assert.equal(
      (await api(owner, "notifications?limit=50")).items.find(
        (n) => n.id === unknownId,
      ).readAt !== null,
      true,
    );
    record(
      "More than page-size cursor navigation has no duplicates; lost committed read response survives reload and unread disappearance; retry reuses exact key",
    );
    // Account switch in the same document must clear prior account notification state.
    await owner.context().clearCookies();
    await owner.context().addCookies(await outsider.context().cookies());
    await owner.evaluate(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "campus:auth-version",
          newValue: "synthetic-switch",
        }),
      ),
    );
    await owner.getByText("Inbox independent user", { exact: true }).waitFor();
    await owner
      .getByRole("heading", { name: "No updates on this page" })
      .waitFor();
    assert.equal(await owner.locator("[data-notification-id]").count(), 0);
    assert.equal(
      await owner
        .getByRole("button", { name: "Retry read request", exact: true })
        .count(),
      0,
    );
    await owner
      .getByRole("link", { name: "Notifications (0 unread)", exact: true })
      .waitFor();
    record(
      "Same-document account switch clears inbox, unread count and per-account recovery state",
    );
    // Contract response fault: unavailable target, never persisted as fabricated business history.
    const unavailableId = randomUUID();
    await owner.route("**/api/v1/notifications?**", async (route) => {
      const data = {
        items: [
          {
            id: unavailableId,
            kind: "message.received",
            templateVersion: 1,
            title: "Activity update",
            description:
              "This activity is no longer available to your account.",
            contextLabel: null,
            createdAt: new Date().toISOString(),
            readAt: null,
            target: null,
            targetAvailable: false,
          },
        ],
        nextCursor: null,
        unreadCount: 1,
        limit: 20,
      };
      await route.fulfill({ json: data });
    });
    await inbox(owner);
    await owner
      .getByText("Target unavailable · Your access may have changed.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await owner
        .getByRole("link", { name: "Open update", exact: true })
        .count(),
      0,
    );
    await audit(owner, "07-unavailable-contract-response");
    await owner.unroute("**/api/v1/notifications?**");
    await owner.route("**/api/v1/notifications?**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({
          detail: "Synthetic temporary service interruption.",
        }),
      }),
    );
    await inbox(owner);
    await button(owner, "Try again").waitFor();
    await audit(owner, "08-list-error");
    await owner.unroute("**/api/v1/notifications?**");
    await button(owner, "Try again").click();
    await owner
      .getByRole("heading", { name: "No updates on this page" })
      .waitFor();
    // Hold a read-only list response to verify the actual loading state.
    let releaseLoading;
    const loadingGate = new Promise((resolve) => {
      releaseLoading = resolve;
    });
    await owner.route("**/api/v1/notifications?**", async (route) => {
      await loadingGate;
      await route.continue();
    });
    await button(owner, "Refresh notifications").click();
    await owner.getByText("Checking updates…", { exact: true }).waitFor();
    assert.equal(await button(owner, "Next page").isDisabled(), true);
    await audit(owner, "09-list-loading");
    releaseLoading();
    await owner.unrouteAll({ behavior: "wait" });
    await owner
      .getByRole("heading", { name: "No updates on this page" })
      .waitFor();
    await owner.keyboard.press("Tab");
    assert.ok(
      await owner.evaluate(() => document.activeElement !== document.body),
    );
    const keyboard = await owner.evaluate(() => ({
      tag: document.activeElement.tagName,
      text: document.activeElement.textContent,
      outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
    }));
    assert.notEqual(keyboard.outlineStyle, "none");
    await owner.screenshot({
      path: path.join(output, "10-keyboard-focus.png"),
      fullPage: true,
    });
    record(
      "Unavailable-target contract response has no link; list error/retry works; keyboard focus visible; all affected states have axe and four-width evidence",
    );
    assert.deepEqual(pageErrors, []);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          ok: true,
          checks,
          visualChecks,
          keyboard,
          pageErrors,
          limits: [
            "Local synthetic sessions; OTP delivery excluded",
            "Funding state simulated in disposable database; no payment",
            "Unavailable target and 503 are explicit browser response faults; no fabricated notifications persisted",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`Evidence: ${output}`);
  } catch (error) {
    for (let i = 0; i < pages.length; i++)
      await pages[i]
        .screenshot({
          path: path.join(output, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
    fs.writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify(
        { error: error.stack, checks, visualChecks, pageErrors },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
