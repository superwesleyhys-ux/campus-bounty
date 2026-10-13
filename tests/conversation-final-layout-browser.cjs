// Scoped Round9 final repairs. Uses only fresh engineering fixtures, not sealed trials.
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
const before = process.env.BEFORE_FINAL_FIX === "1";
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round9",
  `final-layout-${before ? "before" : "after"}-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  geometry = [],
  audits = [],
  errors = [];
let browser, store, fixture;
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const composer = (p) => conv(p).getByLabel("Message", { exact: true });
const saved = (p) =>
  conv(p).getByText(
    "Draft saved in this browser tab for this account. It will be here when you return or reload this tab. Not sent.",
    { exact: true },
  );
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
const url = (type, id) =>
  `${origin}/?view=workspace&tab=${type === "agreement" ? "agreements" : "orders"}&resource=${type}&id=${id}`;
const selected = (p) =>
  p.locator('[data-context-message-id][aria-current="true"]');
async function search(p) {
  await p
    .getByRole("searchbox", { name: "Search this conversation" })
    .fill("Reading width marker");
  await button(p, "Search messages").click();
  await p
    .getByRole("list", { name: "Matching messages" })
    .locator("li")
    .waitFor();
}
async function inspect(p, type) {
  if (!before)
    await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  for (const width of [320, 768, 1024, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    const measured = await p.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      conversation: document
        .querySelector(".cb-conversation")
        .getBoundingClientRect().width,
      controls: document
        .querySelector(".cb-detail-grid > section")
        .getBoundingClientRect().width,
      body: document
        .querySelector(
          '[data-context-message-id][aria-current="true"] .cb-prewrap',
        )
        .getBoundingClientRect().width,
    }));
    geometry.push({ type, width, ...measured });
    assert.ok(measured.document <= width, `${type} overflow ${width}`);
    if (!before) {
      const old = baseline.geometry.find(
        (m) => m.type === type && m.width === width,
      );
      if (width >= 1024) {
        assert.ok(
          measured.conversation > old.conversation * 1.25,
          `${type} genuinely wider desktop`,
        );
        assert.ok(measured.controls >= 300, `${type} controls remain usable`);
      }
      const violations = await p.evaluate(async () =>
        (await axe.run()).violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target),
        })),
      );
      audits.push({ type, width, violations });
      assert.deepEqual(violations, []);
    }
    await p.screenshot({
      path: path.join(output, `${type}-${width}.png`),
      fullPage: true,
    });
  }
  record(
    `${type} ${before ? "baseline geometry" : "wider desktop plus controls/four widths/axe"}`,
  );
}
const baseline = process.env.BASELINE_RESULTS
  ? JSON.parse(fs.readFileSync(process.env.BASELINE_RESULTS, "utf8"))
  : null;
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  if (!before)
    assert.ok(
      baseline?.before,
      "After run requires its retained before measurements",
    );
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const db = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(db.database, /^campus_test_[a-f0-9]{32}$/);
  store = createStore(
    Object.fromEntries(
      ["app", "auth", "worker"].map((role) => {
        const u = connectionString(localConfig(), role, db.database);
        assert.equal(new URL(u).hostname, "127.0.0.1");
        return [role, u];
      }),
    ),
  );
  const market = createMarket(store);
  if (baseline) fixture = baseline.fixture;
  else {
    const [owner, cap] = await seedPeople([
      "Final Layout Publisher",
      "Final Layout Captain",
    ]);
    const task = await market.publishTask(
      owner.id,
      {
        title: "Engineering conversation reading space",
        category: "Research",
        description: "Synthetic local layout and draft check",
        rewardCents: 100,
        milestones: [
          {
            title: "Evidence",
            amountCents: 100,
            deliverable:
              "Describe the result and provide a relevant reference.",
          },
        ],
      },
      key(),
    );
    const app = await market.apply(
      cap.id,
      task.id,
      { proposal: "Synthetic final layout" },
      key(),
    );
    await market.inviteApplicant(owner.id, app.id, {}, key());
    const agreement = await market.acceptInvitation(cap.id, app.id, {}, key());
    const product = await market.publishProduct(
      owner.id,
      {
        title: "Engineering conversation order",
        description: "Synthetic local only",
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
    const marker =
      "Reading width marker. " +
      "Please check the original agreement and confirm the planned collection point before preparing a reply. ".repeat(
        6,
      );
    for (const [field, id] of [
      ["agreement_id", agreement.id],
      ["order_id", order.id],
    ]) {
      assert.ok(["agreement_id", "order_id"].includes(field));
      await store.as(owner.id, (c) =>
        c.query(
          `INSERT INTO campus.messages(sender_id,${field},body,created_at) SELECT $1,$2,CASE WHEN n=8 THEN $3 ELSE 'Ordinary engineering message '||n END,now()+n*interval '1 microsecond' FROM generate_series(1,45)n`,
          [owner.id, id, marker],
        ),
      );
    }
    fixture = { owner, cap, agreementId: agreement.id, orderId: order.id };
  }
  browser = await chromium.launch({ headless: true });
  const p = await (
    await browser.newContext({
      viewport: { width: 1024, height: 950 },
      reducedMotion: "reduce",
    })
  ).newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(p, fixture.cap);
  for (const type of ["agreement", "order"]) {
    const id = fixture[type + "Id"];
    await p.goto(url(type, id));
    await ready(p);
    await composer(p).fill("");
    if (!before) assert.equal(await saved(p).count(), 0);
    const draft = `Unsent ${type} final repair draft`;
    await composer(p).fill(draft);
    if (!before) await saved(p).waitFor();
    const history = conv(p).getByRole("list", { name: "Message history" });
    await history.focus();
    await p.keyboard.press("Home");
    await p.waitForFunction(
      () =>
        document.querySelector('[aria-label="Message history"]').scrollTop ===
        0,
    );
    const ids = await history
      .locator("li")
      .evaluateAll((es) => es.map((e) => e.dataset.messageId));
    await search(p);
    const open = button(p, "Open message in context");
    await open.focus();
    await p.keyboard.press("Enter");
    await selected(p).waitFor();
    assert.equal(
      await selected(p).evaluate((e) => e === document.activeElement),
      true,
    );
    await button(p, "Close message context").click();
    assert.equal(
      await open.evaluate((e) => e === document.activeElement),
      true,
    );
    assert.deepEqual(
      await history
        .locator("li")
        .evaluateAll((es) => es.map((e) => e.dataset.messageId)),
      ids,
    );
    assert.equal(await history.evaluate((e) => e.scrollTop), 0);
    assert.equal(await composer(p).inputValue(), draft);
    await open.click();
    await selected(p).waitFor();
    await inspect(p, type);
    if (before) continue;
    await button(p, "Close message context").click();
    await p
      .getByRole("link", { name: "← Back to workspace", exact: true })
      .click();
    await p.locator(`a[href*="id=${id}"]`).first().click();
    await ready(p);
    assert.equal(await composer(p).inputValue(), draft);
    await saved(p).waitFor();
    await p.reload();
    await ready(p);
    assert.equal(await composer(p).inputValue(), draft);
    await saved(p).waitFor();
    await conv(p).screenshot({
      path: path.join(output, `${type}-draft-restored.png`),
    });
    await button(p, "Send message").click();
    await p.getByText("Message sent and confirmed.", { exact: true }).waitFor();
    assert.equal(await composer(p).inputValue(), "");
    assert.equal(await saved(p).count(), 0);
    record(
      `${type} keyboard return/history/draft preserved; saved status survives route return/reload and disappears after confirmed send`,
    );
  }
  if (before) return;
  // Deliberately unavailable sessionStorage in a separate engineering browser context.
  const blocked = await browser.newContext({
    viewport: { width: 1024, height: 950 },
  });
  await blocked.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) {
      if (
        this === window.sessionStorage &&
        k.startsWith("campus:conversation:")
      )
        throw new DOMException("Engineering blocked storage", "SecurityError");
      return get.call(this, k);
    };
    Storage.prototype.setItem = function (k, v) {
      if (
        this === window.sessionStorage &&
        k.startsWith("campus:conversation:")
      )
        throw new DOMException("Engineering blocked storage", "SecurityError");
      return set.call(this, k, v);
    };
  });
  const b = await blocked.newPage();
  b.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(b, fixture.cap);
  await b.goto(url("agreement", fixture.agreementId));
  await ready(b);
  await composer(b).fill("Memory-only final engineering draft");
  await conv(b)
    .getByText(/Browser storage is unavailable/)
    .waitFor();
  assert.equal(await saved(b).count(), 0);
  await conv(b).screenshot({
    path: path.join(output, "memory-only-warning.png"),
  });
  await b
    .getByRole("link", { name: "← Back to workspace", exact: true })
    .click();
  await b.locator(`a[href*="id=${fixture.agreementId}"]`).first().click();
  await ready(b);
  assert.equal(
    await composer(b).inputValue(),
    "Memory-only final engineering draft",
  );
  assert.equal(await saved(b).count(), 0);
  record(
    "blocked sessionStorage retains honest memory-only warning and route draft without saved claim",
  );
  // A lost real send receipt must never be labelled an ordinary saved unsent draft.
  await p.goto(url("agreement", fixture.agreementId));
  await ready(p);
  await composer(p).fill("Unknown final repair message");
  await saved(p).waitFor();
  const sends = [];
  let lose = true,
    entered,
    release;
  const gate = new Promise((r) => (release = r)),
    sent = new Promise((r) => (entered = r));
  await p.route("**/api/v1/messages", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    sends.push({
      body: r.request().postData(),
      key: r.request().headers()["idempotency-key"],
    });
    const response = await r.fetch();
    if (lose) {
      lose = false;
      entered();
      await gate;
      await r.abort("failed");
    } else await r.fulfill({ response });
  });
  await button(p, "Send message").click();
  await sent;
  assert.equal(await saved(p).count(), 0);
  release();
  await p.getByText("Message outcome not confirmed", { exact: true }).waitFor();
  assert.equal(await saved(p).count(), 0);
  await search(p);
  await button(p, "Open message in context").click();
  await selected(p).waitFor();
  await p.reload();
  await p.getByText("Message outcome not confirmed", { exact: true }).waitFor();
  assert.equal(await composer(p).inputValue(), "Unknown final repair message");
  assert.equal(await saved(p).count(), 0);
  await conv(p).screenshot({
    path: path.join(output, "unknown-request-preserved.png"),
  });
  await button(p, "Recover same message").click();
  await p
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
      { exact: true },
    )
    .waitFor();
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], sends[1]);
  assert.equal(await saved(p).count(), 0);
  record(
    "sending and unknown never claim saved unsent draft; search/reload recover identical original key/body",
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
          before,
          fixture,
          geometry,
          checks,
          audits,
          errors,
          limits:
            "Synthetic loopback engineering fixtures. Storage block and lost send receipt explicitly injected. No external delivery, real user research, forced-revocation diagnostic or preview restart.",
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          output,
          before,
          checks: checks.length,
          audits: audits.length,
          geometry,
          errors,
        },
        null,
        2,
      ),
    );
  });
