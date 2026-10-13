// Fresh engineering UI only. Delay is a held real GET response, not an auth response stub.
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
const pre = process.env.PRE_FIX_OBSERVATION === "1";
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round8",
  `engineering-final-fixes-${pre ? "before" : "after"}-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const observations = [],
  checks = [],
  errors = [];
let browser, store;
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
async function observeLoading(page, url, label, delayed) {
  await page.addInitScript(() => {
    window.__conversationTransitions = [];
    new MutationObserver(() => {
      const node = document.querySelector('[aria-label="Conversation"]');
      if (!node) return;
      const text = node.textContent;
      const state = {
        loading: text.includes("Loading messages…"),
        denied: text.includes("Conversation unavailable."),
        privateRows: node.querySelectorAll("[data-message-id]").length,
      };
      const records = window.__conversationTransitions;
      if (JSON.stringify(state) !== JSON.stringify(records.at(-1)))
        records.push(state);
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  let release, intercepted;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    intercepted = resolve;
  });
  const routePattern = "**/api/v1/conversations?*";
  if (delayed)
    await page.route(routePattern, async (route) => {
      const response = await route.fetch();
      intercepted();
      await held;
      await route.fulfill({ response });
    });
  await page.goto(url);
  if (delayed) {
    await started;
    await conv(page).getByText("Loading messages…", { exact: true }).waitFor();
    await conv(page).screenshot({
      path: path.join(output, `${label}-loading.png`),
    });
    release();
  }
  await ready(page);
  if (delayed) await page.unroute(routePattern);
  const transitions = await page.evaluate(
    () => window.__conversationTransitions,
  );
  observations.push({ label, delayedRealResponse: delayed, transitions });
  await conv(page).screenshot({
    path: path.join(output, `${label}-loaded.png`),
  });
  if (!pre) {
    assert.ok(
      transitions.some((s) => s.loading),
      `${label}: observed actual loading`,
    );
    assert.ok(
      transitions.every((s) => !s.denied),
      `${label}: normal loading must never announce denied access`,
    );
    checks.push(`${label}: loading and success without access warning`);
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
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => {
      const url = connectionString(localConfig(), role, fixture.database);
      assert.equal(new URL(url).hostname, "127.0.0.1");
      return [role, url];
    }),
  );
  store = createStore(urls);
  const market = createMarket(store);
  const [owner, captain, peer] = await seedPeople([
    "Final Fix Publisher",
    "Final Fix Captain",
    "Final Fix Signer",
  ]);
  async function signed(extra) {
    const task = await market.publishTask(
      owner.id,
      {
        title: `Final fix ${extra ? "two" : "one"} signer ${run}`,
        category: "Research",
        description: "Fresh engineering-only copy and initial-loading checks",
        rewardCents: 100,
        milestones: [
          { title: "Evidence", amountCents: 100, deliverable: "Local check" },
        ],
      },
      key(),
    );
    const application = await market.apply(
      captain.id,
      task.id,
      { proposal: "Local test" },
      key(),
    );
    await market.inviteApplicant(owner.id, application.id, {}, key());
    const agreement = await market.acceptInvitation(
      captain.id,
      application.id,
      {},
      key(),
    );
    if (extra)
      await withFixture((c) =>
        c.query(
          "INSERT INTO campus.agreement_members(agreement_id,user_id) VALUES($1,$2)",
          [agreement.id, peer.id],
        ),
      );
    await market.sendMessage(
      owner.id,
      { agreementId: agreement.id, body: "Engineering private instruction" },
      key(),
    );
    return agreement;
  }
  const single = await signed(false),
    multi = await signed(true);
  const product = await market.publishProduct(
    owner.id,
    {
      title: `Final fix order ${run}`,
      description: "Synthetic",
      priceCents: 100,
      stock: 1,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const quote = await market.quote(
    captain.id,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order = await market.order(captain.id, { quoteId: quote.id }, key());
  browser = await chromium.launch({ headless: true });
  const page = await (
    await browser.newContext({ viewport: { width: 1024, height: 900 } })
  ).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(page, captain);
  const agreementUrl = (id) =>
    `${origin}/?view=workspace&tab=agreements&resource=agreement&id=${id}`;
  await observeLoading(
    page,
    agreementUrl(single.id),
    "agreement-natural",
    false,
  );
  if (!pre) {
    await page
      .getByText(
        "1 signed collaborator (publisher not included) · 1 milestone",
        { exact: true },
      )
      .waitFor();
    await conv(page).getByText("Participants (2)", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(output, "single-counts.png"),
      fullPage: true,
    });
    checks.push(
      "singular signed collaborator/milestone and conversation includes publisher",
    );
  }
  await observeLoading(page, agreementUrl(multi.id), "agreement-delayed", true);
  if (!pre) {
    await page
      .getByText(
        "2 signed collaborators (publisher not included) · 1 milestone",
        { exact: true },
      )
      .waitFor();
    await conv(page).getByText("Participants (3)", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(output, "multiple-counts.png"),
      fullPage: true,
    });
    checks.push(
      "plural signed collaborator count explicitly excludes publisher",
    );
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(output, `count-copy-${width}.png`),
        fullPage: true,
      });
    }
    checks.push(
      "count clarification fits 320/768/1024/1440 without horizontal overflow",
    );
  }
  await observeLoading(
    page,
    `${origin}/?view=workspace&tab=orders&resource=order&id=${order.id}`,
    "order-delayed",
    true,
  );
  if (pre) return;
  // Actual completed revocation before a normal refresh. No queued writes or race operation.
  const peerPage = await (await browser.newContext()).newPage();
  peerPage.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(peerPage, peer);
  await peerPage.goto(agreementUrl(multi.id));
  await ready(peerPage);
  await conv(peerPage)
    .getByLabel("Message", { exact: true })
    .fill("Private unsent engineering draft");
  assert.equal(await conv(peerPage).locator("[data-message-id]").count(), 1);
  await withFixture((c) =>
    c.query(
      "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
      [multi.id, peer.id],
    ),
  );
  await button(peerPage, "Refresh messages").click();
  await conv(peerPage)
    .getByText(/Conversation unavailable\./)
    .waitFor();
  assert.equal(await conv(peerPage).locator("[data-message-id]").count(), 0);
  assert.equal(
    await conv(peerPage)
      .getByRole("list", { name: "Conversation participants" })
      .count(),
    0,
  );
  assert.equal(
    await conv(peerPage).getByLabel("Message", { exact: true }).count(),
    0,
  );
  assert.doesNotMatch(
    await conv(peerPage).innerText(),
    /Engineering private instruction|Private unsent engineering draft/,
  );
  assert.match(
    await conv(peerPage).innerText(),
    /Refresh messages to check your access again/,
  );
  assert.equal(await button(peerPage, "Refresh messages").isEnabled(), true);
  await conv(peerPage).screenshot({
    path: path.join(output, "actual-denied-cleared.png"),
  });
  checks.push(
    "ordinary actual removed-signer 404 clears conversation private content and gives retry action",
  );
  // A normal outage on initial load is retryable and is never permission loss.
  await page.route("**/api/v1/conversations?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Engineering temporary outage",
        code: "unavailable",
      }),
    }),
  );
  await page.goto(agreementUrl(single.id));
  await conv(page)
    .getByText("Engineering temporary outage", { exact: true })
    .waitFor();
  assert.doesNotMatch(
    await conv(page).innerText(),
    /Conversation unavailable\./,
  );
  await page.unroute("**/api/v1/conversations?*");
  await button(page, "Refresh messages").click();
  await ready(page);
  checks.push(
    "injected initial 503 is retryable without false permission denial",
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
    const result = {
      run,
      preFixObservation: pre,
      checks,
      observations,
      errors,
      proof:
        "Fresh synthetic engineering accounts; real local fixture, auth verifier, browser and API. One explicitly held real GET response per delayed case, one injected 503 after the fix. Sequential completed synthetic signer removal before ordinary refresh. No forced authorization race, preview migration/restart, blind trial identity or mail delivery.",
    };
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      JSON.stringify(
        {
          evidence: output,
          checks: checks.length,
          falseDenialObserved: observations.some((o) =>
            o.transitions.some((s) => s.denied),
          ),
          errors,
        },
        null,
        2,
      ),
    );
  });
