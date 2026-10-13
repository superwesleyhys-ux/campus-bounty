// Round9 engineering-only fixtures; never reads blind trial data.
const assert = require("node:assert/strict");
const fs = require("node:fs"),
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
  "docs/evidence/interaction-round9",
  `engineering-discovery-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  audits = [],
  errors = [];
let browser, store;
const record = (s) => {
  checks.push(s);
  console.log("PASS " + s);
};
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const results = (p) => p.getByRole("list", { name: "Matching messages" });
const selected = (p) =>
  p.locator('[data-context-message-id][aria-current="true"]');
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
const url = (type, id) =>
  `${origin}/?view=workspace&tab=${type === "agreement" ? "agreements" : "orders"}&resource=${type}&id=${id}`;
async function search(p, q) {
  await p.getByRole("searchbox", { name: "Search this conversation" }).fill(q);
  await button(p, "Search messages").click();
  await conv(p)
    .getByText(/matching messages shown|No messages match/)
    .waitFor();
}
async function audit(p, name) {
  await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  for (const width of [320, 768, 1024, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} overflow ${width}`,
    );
    const violations = await p.evaluate(async () =>
      (await axe.run()).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        targets: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
          html: n.html,
        })),
      })),
    );
    audits.push({ name, width, violations });

    await p.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
    assert.deepEqual(violations, [], `${name} axe ${width}`);
  }
  record(`${name}: four widths without overflow/axe violations`);
}
async function hold(p, pattern) {
  let release, started, finished;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (started = r)),
    done = new Promise((r) => (finished = r));
  await p.route(pattern, async (r) => {
    try {
      const response = await r.fetch();
      started();
      await gate;
      await r.fulfill({ response });
    } finally {
      finished();
    }
  });
  return {
    entered,
    release,
    remove: async () => {
      await done;
      await p.unroute(pattern);
    },
  };
}

(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const f = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(f.database, /^campus_test_[a-f0-9]{32}$/);
  store = createStore(
    Object.fromEntries(
      ["app", "auth", "worker"].map((role) => {
        const u = connectionString(localConfig(), role, f.database);
        assert.equal(new URL(u).hostname, "127.0.0.1");
        return [role, u];
      }),
    ),
  );
  const market = createMarket(store);
  const [owner, cap, peer] = await seedPeople([
    "Discovery Publisher",
    "Discovery Captain",
    "Discovery Signer",
  ]);
  const task = await market.publishTask(
    owner.id,
    {
      title: `Discovery engineering ${run}`,
      category: "Research",
      description: "Synthetic",
      rewardCents: 100,
      milestones: [
        { title: "Evidence", amountCents: 100, deliverable: "Local check" },
      ],
    },
    key(),
  );
  const application = await market.apply(
    cap.id,
    task.id,
    { proposal: "Synthetic" },
    key(),
  );
  await market.inviteApplicant(owner.id, application.id, {}, key());
  const agreement = await market.acceptInvitation(
    cap.id,
    application.id,
    {},
    key(),
  );
  await withFixture((c) =>
    c.query(
      "INSERT INTO campus.agreement_members(agreement_id,user_id) VALUES($1,$2)",
      [agreement.id, peer.id],
    ),
  );
  const literal =
    "Literal 50%_\\ <img src=x onerror=alert(1)> & <script>not code</script>";
  const oldBody =
    "Old agreement marker " + "😀".repeat(170) + " complete original tail";
  const seeded = await store.as(owner.id, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,agreement_id,body,created_at) SELECT $1,$2,CASE WHEN n=12 THEN $3 WHEN n=13 THEN $4 WHEN n<=40 THEN 'Archive match '||n ELSE 'Recent ordinary '||n END,'2026-01-01T00:00:00.123001Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,145)n RETURNING id,body",
      [owner.id, agreement.id, oldBody, literal],
    ),
  );
  const old = seeded.rows.find((m) => m.body === oldBody);
  const product = await market.publishProduct(
    owner.id,
    {
      title: `Discovery order ${run}`,
      description: "Synthetic",
      priceCents: 100,
      stock: 1,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const quote = await market.quote(
    cap.id,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order = await market.order(cap.id, { quoteId: quote.id }, key());
  const orderRows = await store.as(owner.id, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,order_id,body,created_at) SELECT $1,$2,CASE WHEN n=4 THEN 'Old order marker' ELSE 'Order ordinary '||n END,'2026-01-01T00:00:00.123001Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,130)n RETURNING id,body",
      [owner.id, order.id],
    ),
  );
  const oldOrder = orderRows.rows.find((m) => m.body === "Old order marker");
  browser = await chromium.launch({ headless: true });
  const p = await (
    await browser.newContext({
      viewport: { width: 1024, height: 950 },
      reducedMotion: "reduce",
    })
  ).newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(p, cap);
  await p.goto(url("agreement", agreement.id));
  await ready(p);
  const history = p.getByRole("list", { name: "Message history" });
  assert.equal(await history.locator("li").count(), 30);
  await button(p, "Load older messages").click();
  await p.waitForFunction(
    () => document.querySelectorAll("[data-message-id]").length === 60,
  );
  const ids = await history
    .locator("li")
    .evaluateAll((es) => es.map((e) => e.dataset.messageId));
  await history.focus();
  await p.keyboard.press("Home");
  await p.waitForFunction(
    () =>
      document.querySelector('[aria-label="Message history"]').scrollTop === 0,
  );
  const top = await history.evaluate((e) => e.scrollTop);
  await conv(p)
    .getByLabel("Message", { exact: true })
    .fill("Preserved discovery draft");
  const sb = p.getByRole("searchbox", { name: "Search this conversation" });
  await sb.fill("Archive match");
  await sb.press("Enter");
  await results(p).locator("li").first().waitFor();
  assert.equal(await results(p).locator("li").count(), 20);
  await button(p, "Load more matching messages").click();
  await p.waitForFunction(
    () => document.querySelectorAll("[data-search-message-id]").length === 38,
  );
  assert.equal(await button(p, "Load more matching messages").count(), 0);
  record("full-history literal search paginates38 old matches beyond loaded60");
  await search(p, "Old agreement marker");
  assert.equal(await results(p).locator("li").count(), 1);
  assert.equal(await results(p).getByText(oldBody, { exact: true }).count(), 1);
  const open = button(p, "Open message in context");
  await open.focus();
  await p.keyboard.press("Enter");
  await selected(p).waitFor();
  assert.equal(
    await selected(p).getAttribute("data-context-message-id"),
    old.id,
  );
  assert.equal(
    await selected(p).evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal(await p.locator("[data-context-message-id]").count(), 21);
  assert.equal(
    await selected(p).getByText(oldBody, { exact: true }).count(),
    1,
  );
  assert.match(
    await p
      .getByRole("region", { name: "Selected message context" })
      .innerText(),
    /More messages exist before.*More messages exist after/s,
  );

  await button(p, "Close message context").click();
  assert.equal(await open.evaluate((e) => e === document.activeElement), true);
  assert.deepEqual(
    await history
      .locator("li")
      .evaluateAll((es) => es.map((e) => e.dataset.messageId)),
    ids,
  );
  assert.equal(await history.evaluate((e) => e.scrollTop), top);
  assert.equal(
    await conv(p).getByLabel("Message", { exact: true }).inputValue(),
    "Preserved discovery draft",
  );
  record(
    "exact old context21, truthful bounds, keyboard focus return, history/scroll/draft preserved",
  );
  await open.click();
  await selected(p).waitFor();
  await audit(p, "agreement-search-selected");
  await button(p, "Close message context").click();
  await search(p, "50%_\\");
  assert.equal(await results(p).getByText(literal, { exact: true }).count(), 1);
  assert.equal(await results(p).locator("img,script").count(), 0);
  await search(p, "😀".repeat(160));
  assert.equal(await results(p).locator("li").count(), 1);
  await sb.fill("😀".repeat(161));
  await button(p, "Search messages").click();
  await p
    .getByText("Enter 1–160 characters to search this conversation.", {
      exact: true,
    })
    .waitFor();
  await search(p, "No such engineering marker");
  assert.equal(await results(p).locator("li").count(), 0);
  await button(p, "Clear search").click();
  assert.equal(await sb.inputValue(), "");
  assert.equal(await sb.evaluate((e) => e === document.activeElement), true);
  record(
    "literal safe text,160 Unicode emoji allowed,161 rejected, empty and clear keyboard state",
  );
  // Hold successful real query; input edit/clear/new query invalidates it.
  const held = await hold(p, "**/api/v1/conversations/search?*q=Archive*");
  await sb.fill("Archive match");
  await button(p, "Search messages").click();
  await held.entered;
  assert.match(await conv(p).innerText(), /Searching conversation/);
  assert.doesNotMatch(await conv(p).innerText(), /No messages match/);
  await search(p, "Old agreement marker");
  held.release();
  await held.remove();
  await p.waitForTimeout(150);
  assert.equal(await results(p).locator("li").count(), 1);
  assert.equal(await results(p).getByText(oldBody, { exact: true }).count(), 1);
  record(
    "held real successful old query cannot overwrite new query; no premature empty",
  );
  await p.goto(`${origin}/?view=notifications`);
  await p
    .getByRole("heading", { name: "Notifications", exact: true })
    .waitFor();
  await p.locator(".cb-notification-item").first().waitFor();
  // Navigate the real inbox pages; immutable notification history stays untouched.
  for (
    let index = 0;
    index < 20 && !(await p.locator(`a[href*="messageId=${old.id}"]`).count());
    index++
  ) {
    await button(p, "Next page").click();
    await p
      .getByText("Checking updates…", { exact: true })
      .waitFor({ state: "hidden" });
  }
  const card = p
    .locator(".cb-notification-item")
    .filter({ has: p.getByText(/Preview shortened/) })
    .first();
  await card.waitFor();
  assert.match(await card.innerText(), /Discovery Publisher/);
  assert.match(await card.innerText(), /Publisher/);
  assert.match(await card.innerText(), /Unread/);
  const href = await card
    .getByRole("link", { name: "Open update" })
    .getAttribute("href");
  assert.match(href, new RegExp("messageId=" + old.id));
  await audit(p, "notification-preview");
  await card.getByRole("link", { name: "Open update" }).click();
  await selected(p).waitFor();
  assert.equal(
    await selected(p).getAttribute("data-context-message-id"),
    old.id,
  );
  await p.reload();
  await selected(p).waitFor();
  assert.equal(
    await selected(p).getAttribute("data-context-message-id"),
    old.id,
  );
  assert.equal(
    await conv(p).getByLabel("Message", { exact: true }).inputValue(),
    "Preserved discovery draft",
  );
  const unread = await withFixture(
    async (c) =>
      (
        await c.query(
          "SELECT read_at FROM campus.notifications WHERE event_key=$1 AND recipient_id=$2",
          ["message:" + old.id, cap.id],
        )
      ).rows[0],
  );
  assert.equal(unread.read_at, null);
  record(
    "notification current author/bounded preview exact old link/reload; no read acknowledgement",
  );
  // Same-page Next-integrated URL updates and unknown send recovery preserve the original request.
  const sends = [];
  let lose = true;
  await p.route("**/api/v1/messages", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    sends.push({
      body: r.request().postData(),
      key: r.request().headers()["idempotency-key"],
    });
    const response = await r.fetch();
    if (lose) {
      lose = false;
      await r.abort("failed");
    } else await r.fulfill({ response });
  });
  await conv(p)
    .getByLabel("Message", { exact: true })
    .fill("Unknown discovery body");
  await button(p, "Send message").click();
  await p.getByText("Message outcome not confirmed", { exact: true }).waitFor();
  await search(p, "50%_\\");
  await button(p, "Open message in context").click();
  await selected(p).getByText(literal, { exact: true }).waitFor();
  assert.equal(
    await conv(p).getByLabel("Message", { exact: true }).isDisabled(),
    true,
  );
  await p.reload();
  await p.getByText("Message outcome not confirmed", { exact: true }).waitFor();
  assert.equal(
    await conv(p).getByLabel("Message", { exact: true }).inputValue(),
    "Unknown discovery body",
  );
  await button(p, "Recover same message").click();
  await p
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
      { exact: true },
    )
    .waitFor();
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], sends[1]);
  await p.unroute("**/api/v1/messages");
  record(
    "same-page selection/reload preserve unknown body/key; explicit recovery uses identical original request",
  );
  await p.goto(url("order", order.id));
  await ready(p);
  await search(p, "Old order marker");
  await button(p, "Open message in context").click();
  await selected(p).waitFor();
  assert.equal(
    await selected(p).getAttribute("data-context-message-id"),
    oldOrder.id,
  );
  assert.equal(await p.locator("[data-context-message-id]").count(), 14);
  await p.reload();
  await selected(p).waitFor();
  await audit(p, "order-selected");
  record("old order search/context/direct reload authorized and independent");
  await p.goto(`${origin}/?view=notifications`);
  await p.locator(".cb-notification-item").first().waitFor();
  for (
    let index = 0;
    index < 20 &&
    !(await p.locator(`a[href*="messageId=${oldOrder.id}"]`).count());
    index++
  ) {
    await button(p, "Next page").click();
    await p
      .getByText("Checking updates…", { exact: true })
      .waitFor({ state: "hidden" });
  }
  await p.locator(`a[href*="messageId=${oldOrder.id}"]`).click();
  await selected(p).getByText("Old order marker", { exact: true }).waitFor();
  await p.reload();
  await selected(p).getByText("Old order marker", { exact: true }).waitFor();
  const orderUnread = await withFixture(
    async (c) =>
      (
        await c.query(
          "SELECT read_at FROM campus.notifications WHERE event_key=$1 AND recipient_id=$2",
          ["message:" + oldOrder.id, cap.id],
        )
      ).rows[0],
  );
  assert.equal(orderUnread.read_at, null);
  record(
    "order notification opens exact old message and survives reload without acknowledgement",
  );
  await p.goto(url("agreement", agreement.id) + "&messageId=" + key());
  await p
    .getByText(/This message is unavailable in this conversation/)
    .waitFor();
  assert.equal(await p.locator("[data-context-message-id]").count(), 0);
  assert.ok(await conv(p).getByLabel("Message", { exact: true }).isVisible());
  record(
    "missing exact message honest recoverable state retains authorized conversation",
  );
  await p.goto(url("agreement", agreement.id));
  await ready(p);
  await search(p, "Old agreement marker");
  await button(p, "Open message in context").click();
  await selected(p).waitFor();
  await withFixture((c) =>
    c.query("UPDATE campus.users SET display_name=$1 WHERE id=$2", [
      "Discovery Renamed Publisher",
      owner.id,
    ]),
  );
  await button(p, "Refresh messages").click();
  await ready(p);
  await selected(p)
    .getByText(/Discovery Renamed Publisher/)
    .waitFor();
  assert.equal(await results(p).count(), 0);
  assert.doesNotMatch(await conv(p).innerText(), /Discovery Publisher/);
  record(
    "history refresh invalidates search and revalidates selected current author",
  );
  // Context reads remain cancellable independently from the original history.
  await button(p, "Close message context").click();
  await search(p, "Old agreement marker");
  const selectedHeld = await hold(p, "**/api/v1/conversations/message?*");
  await button(p, "Open message in context").click();
  await selectedHeld.entered;
  await button(p, "Close message context").click();
  selectedHeld.release();
  await selectedHeld.remove();
  await p.waitForTimeout(150);
  assert.equal(await p.locator("[data-context-message-id]").count(), 0);
  record("closing selected panel rejects its held real successful response");
  const cleared = await hold(p, "**/api/v1/conversations/search?*q=Archive*");
  await sb.fill("Archive match");
  await button(p, "Search messages").click();
  await cleared.entered;
  await button(p, "Clear search").click();
  cleared.release();
  await cleared.remove();
  await p.waitForTimeout(150);
  assert.equal(await results(p).count(), 0);
  record("clear rejects its held real successful search response");
  await p.route("**/api/v1/conversations/search?*", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Engineering search outage",
        code: "unavailable",
      }),
    }),
  );
  await sb.fill("Old agreement marker");
  await button(p, "Search messages").click();
  await p.getByText("Engineering search outage", { exact: true }).waitFor();
  assert.doesNotMatch(
    await conv(p).innerText(),
    /Conversation unavailable|No messages match/,
  );
  await p.unroute("**/api/v1/conversations/search?*");
  await button(p, "Search messages").click();
  await results(p).locator("li").first().waitFor();
  await p.route("**/api/v1/conversations/message?*", (r) =>
    r.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Engineering selected outage",
        code: "unavailable",
      }),
    }),
  );
  await button(p, "Open message in context").click();
  await p.getByText("Engineering selected outage", { exact: true }).waitFor();
  assert.doesNotMatch(await conv(p).innerText(), /Conversation unavailable/);
  await p.unroute("**/api/v1/conversations/message?*");
  await button(p, "Retry selected message").click();
  await selected(p).waitFor();
  record(
    "explicit search/context503 fault injection remains retryable without false denial or empty",
  );
  // Ordinary completed removal before a new request, never a forced revocation race.
  const peerPage = await (await browser.newContext()).newPage();
  peerPage.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(peerPage, peer);
  await peerPage.goto(url("agreement", agreement.id));
  await ready(peerPage);
  await search(peerPage, "Old agreement marker");
  await button(peerPage, "Open message in context").click();
  await selected(peerPage).waitFor();
  await conv(peerPage)
    .getByLabel("Message", { exact: true })
    .fill("Hidden denied draft");
  await withFixture((c) =>
    c.query(
      "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
      [agreement.id, peer.id],
    ),
  );
  await button(peerPage, "Search messages").click();
  await conv(peerPage)
    .getByText(/Conversation unavailable/)
    .waitFor();
  assert.equal(
    await peerPage
      .locator(
        "[data-search-message-id],[data-context-message-id],[data-message-id]",
      )
      .count(),
    0,
  );
  assert.equal(
    await conv(peerPage).getByLabel("Message", { exact: true }).count(),
    0,
  );
  record(
    "completed actual permission removal clears all private panels/history/draft presentation",
  );
  // Client session-change invalidation with a held real reauthentication response.
  // Same account remains authorized afterwards; its fresh history may correctly return.
  await button(p, "Close message context").click();
  const pending = await hold(p, "**/api/v1/conversations/search?*q=Archive*");
  await sb.fill("Archive match");
  await button(p, "Search messages").click();
  await pending.entered;
  const reauth = await hold(p, "**/api/v1/me");
  await p.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "campus:account-version",
        newValue: "engineering-session-change",
      }),
    ),
  );
  await reauth.entered;
  pending.release();
  await pending.remove();
  await p.waitForTimeout(150);
  assert.equal(
    await p
      .locator(
        "[data-search-message-id],[data-context-message-id],[data-message-id]",
      )
      .count(),
    0,
  );
  reauth.release();
  await reauth.remove();
  await ready(p);
  assert.equal(
    await p
      .locator("[data-search-message-id],[data-context-message-id]")
      .count(),
    0,
  );
  record(
    "session event hides all private content during real reauthorization; old held search never repopulates after fresh history",
  );
  assert.deepEqual(errors, []);
})()
  .catch((e) => {
    errors.push(e.stack);
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
          limits:
            "Synthetic loopback accounts and existing guarded fixture session helper; real API with explicitly held GETs and one lost send response. No external OTP, forced-revocation race, real user research or preview restart.",
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        { output, checks: checks.length, audits: audits.length, errors },
        null,
        2,
      ),
    );
  });
