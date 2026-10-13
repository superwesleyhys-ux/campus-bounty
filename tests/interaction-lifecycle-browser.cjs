// Real UI regression against the disposable loopback fixture only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const origin = process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3020";
if (new URL(origin).hostname !== "127.0.0.1")
  throw Error("Loopback fixture only");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidence = path.resolve(
  "docs/evidence/interaction-round2",
  `browser-${run}`,
);
fs.mkdirSync(evidence, { recursive: true });
const checks = [],
  errors = [],
  regressions = [];
const record = (check, extra = {}) => checks.push({ check, ...extra });
async function login(page, name) {
  // Optional local-only session reuse avoids OTP throttling while reproducing
  // failures. These files stay in the ignored, owner-only fixture directory.
  const state = path.resolve(
    `.data/backend/interaction/lifecycle-${name}.state.json`,
  );
  if (process.env.CAMPUS_REUSE_BROWSER_AUTH === "1" && fs.existsSync(state)) {
    await page
      .context()
      .addCookies(JSON.parse(fs.readFileSync(state, "utf8")).cookies);
    await page.goto(origin);
    await Promise.race([
      page.getByRole("button", { name: "Sign out", exact: true }).waitFor(),
      page.getByLabel("University email", { exact: true }).waitFor(),
    ]);
    if (
      await page
        .getByRole("button", { name: "Sign out", exact: true })
        .isVisible()
    )
      return;
  }
  await page.goto(origin);
  await page
    .getByLabel("University email", { exact: true })
    .fill(`${name}@campus.example.test`);
  const started = Date.now();
  await page
    .getByRole("button", { name: "Email me a sign-in code", exact: true })
    .click();
  await page.getByLabel("Sign-in code", { exact: true }).waitFor();
  const mail = path.resolve(`.data/backend/interaction/${name}.txt`);
  let code;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(mail) && fs.statSync(mail).mtimeMs >= started)
      code = fs
        .readFileSync(mail, "utf8")
        .match(/verification code is (\d{6})/)?.[1];
    if (code) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, "Synthetic OTP arrived");
  await page.getByLabel("Sign-in code", { exact: true }).fill(code);
  await page.getByLabel("Your display name").fill(name);
  await page
    .getByRole("button", { name: "Verify and continue", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  if (process.env.CAMPUS_REUSE_BROWSER_AUTH === "1") {
    await page.context().storageState({ path: state });
    fs.chmodSync(state, 0o600);
  }
}
const button = (page, name) => page.getByRole("button", { name, exact: true });
const card = (page, proposal) =>
  page
    .locator("article")
    .filter({ has: page.getByText(proposal, { exact: true }) });
async function apply(page, url, proposal) {
  await page.goto(url);
  await page.getByLabel("Your proposal").fill(proposal);
  await button(page, "Send application").click();
  await card(page, proposal).waitFor();
}
async function publish(page, kind, title) {
  await page.goto(`${origin}/?view=publish&kind=${kind}`);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Description", { exact: true })
    .fill("A synthetic campus lifecycle verification listing.");
  if (kind === "task") {
    await page.getByLabel("Total bounty reward (USD)").fill("100");
    await page.getByLabel("Target delivery date").fill("2027-04-30");
  } else {
    await page.getByLabel("Price per item (USD)").fill("12");
    await page.getByLabel("Available quantity").fill("2");
  }
  await button(page, "Continue").click();
  if (kind === "task") {
    await page
      .getByLabel("Milestone title", { exact: true })
      .fill("Written results");
    await page
      .getByLabel("Expected deliverable", { exact: true })
      .fill("One reproducible report");
    await page
      .getByLabel("Acceptance criteria", { exact: true })
      .fill("Include methods and source records");
    await page.getByLabel("Milestone reward (USD)").fill("100");
  }
  await button(page, "Continue").click();
  await button(page, "Publish listing").click();
  await page.waitForURL((u) => !!u.searchParams.get("id"));
  await page
    .getByRole("heading", { name: title, level: 1, exact: true })
    .waitFor();
  return page.url();
}
async function audit(page, name) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const issues = await page.evaluate(async () =>
    (await axe.run()).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      count: v.nodes.length,
    })),
  );
  assert.deepEqual(issues, [], `axe ${name}`);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} overflow at ${width}`,
    );
  }
  await page.screenshot({
    path: path.join(evidence, `${name}.png`),
    fullPage: true,
  });
  record(name, {
    axeViolations: issues.length,
    widths: [320, 768, 1024, 1440],
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  try {
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      pages.push(page);
    }
    const [owner, alex, sam] = pages;
    await login(owner, "professor");
    await login(alex, "alex");
    await login(sam, "sam");
    const taskUrl = await publish(owner, "task", `Lifecycle bounty ${run}`);
    const first = `Proposal A ${run}`;
    await apply(alex, taskUrl, first);
    await button(card(alex, first), "Withdraw application").click();
    assert.equal(
      await alex.locator(":focus").innerText(),
      "Withdraw application?",
    );
    await button(card(alex, first), "Keep application").click();
    assert.equal(
      await alex.locator(":focus").innerText(),
      "Withdraw application",
    );
    await button(card(alex, first), "Withdraw application").click();
    await audit(alex, "withdraw-confirmation");
    await button(card(alex, first), "Confirm withdrawal").click();
    await card(alex, first).getByText("withdrawn", { exact: true }).waitFor();
    await alex.getByLabel("Your proposal").waitFor();
    record(
      "Withdrawal confirmation can be cancelled with focus restored; confirmed withdrawal preserves history and unlocks reapplication",
    );
    const second = `Proposal B ${run}`;
    await apply(alex, taskUrl, second);
    await owner.goto(taskUrl);
    await button(card(owner, second), "Decline application").click();
    await button(card(owner, second), "Confirm decline").click();
    await card(owner, second).getByText("declined", { exact: true }).waitFor();
    await alex.reload();
    await card(alex, second).getByText("declined", { exact: true }).waitFor();
    record(
      "Publisher rejection visible to applicant; previous withdrawn proposal retained",
    );
    const third = `Proposal C ${run}`,
      alternative = `Alternative ${run}`;
    await apply(alex, taskUrl, third);
    await apply(sam, taskUrl, alternative);
    await owner.goto(taskUrl);
    await button(card(owner, third), "Invite this applicant").click();
    await card(owner, third).getByText("invited", { exact: true }).waitFor();
    await alex.reload();
    await button(card(alex, third), "Review invitation").click();
    await button(card(alex, third), "Accept invitation").waitFor();
    await button(card(alex, third), "Decline invitation").click();
    await button(card(alex, third), "Confirm decline").click();
    await card(alex, third).getByText("withdrawn", { exact: true }).waitFor();
    const focusAfterDecline = await alex.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent,
    }));
    if (focusAfterDecline.tag !== "H3")
      regressions.push({
        check: "Declining an open invitation review retains card heading focus",
        actual: focusAfterDecline.tag,
      });
    record("Invited applicant can decline without creating agreement");
    const final = `Final proposal ${run}`;
    await apply(alex, taskUrl, final);
    await owner.goto(taskUrl);
    for (const proposal of [final, alternative]) {
      await button(card(owner, proposal), "Invite this applicant").click();
      await card(owner, proposal)
        .getByText("invited", { exact: true })
        .waitFor();
    }
    await alex.reload();
    await button(card(alex, final), "Review invitation").click();
    await button(card(alex, final), "Accept invitation").click();
    await alex.getByText("Waiting for funding", { exact: true }).waitFor();
    await sam.reload();
    await card(sam, alternative)
      .getByText("Not selected", { exact: true })
      .waitFor();
    assert.equal(
      await button(card(sam, alternative), "Review invitation").count(),
      0,
    );
    await audit(sam, "nonselected-proposal");
    await alex.goto(taskUrl);
    assert.equal(
      await button(card(alex, final), "Withdraw application").count(),
      0,
    );
    record(
      "Agreement creation closes other active invitations, preserves accepted proposal and retains real funding gate",
    );
    const productUrl = await publish(owner, "product", `Lifecycle book ${run}`);
    await alex.goto(productUrl);
    await button(alex, "Review total").click();
    await button(alex, "Create unpaid reservation").click();
    await alex
      .locator(".cb-badge")
      .getByText("Unpaid reservation", { exact: true })
      .waitFor();
    const orderUrl = alex.url();
    await owner.goto(orderUrl);
    await owner
      .locator(".cb-badge")
      .getByText("Unpaid reservation", { exact: true })
      .waitFor();
    assert.equal(await button(owner, "Cancel reservation").count(), 0);
    await button(alex, "Cancel reservation").click();
    await audit(alex, "cancel-confirmation");
    // Commit on the server, then interrupt only the response. Retrying must recover
    // the same cancellation without releasing stock twice.
    await alex.route(
      "**/api/v1/orders/*/cancellation",
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await button(alex, "Confirm cancellation").click();
    await alex.getByText("We couldn’t finish that.", { exact: true }).waitFor();
    if (await button(alex, "Keep reservation").count())
      regressions.push({
        check:
          "Unknown cancellation result must not offer to keep an already-cancelled reservation",
      });
    await button(alex, "Confirm cancellation").click();
    await alex.getByText("cancelled", { exact: true }).waitFor();
    await audit(alex, "cancelled-order");
    await alex
      .getByRole("link", {
        name: "View listing and availability →",
        exact: true,
      })
      .click();
    await alex.getByText("2 available", { exact: true }).waitFor();
    await button(alex, "Review total").click();
    await button(alex, "Create unpaid reservation").click();
    await alex
      .locator(".cb-badge")
      .getByText("Unpaid reservation", { exact: true })
      .waitFor();
    assert.notEqual(alex.url(), orderUrl);
    await owner.goto(productUrl);
    await owner.getByText("1 available", { exact: true }).waitFor();
    await button(alex, "Cancel reservation").click();
    let cancellationRequests = 0;
    alex.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/cancellation"))
        cancellationRequests++;
    });
    await alex.route(
      "**/api/v1/orders/*/cancellation",
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await button(alex, "Confirm cancellation").click();
    await alex.getByText("We couldn’t finish that.", { exact: true }).waitFor();
    assert.equal(await button(alex, "Keep reservation").count(), 0);
    await button(alex, "Check current status").click();
    await alex.getByText("cancelled", { exact: true }).waitFor();
    await alex
      .getByText("We couldn’t finish that.", { exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      cancellationRequests,
      1,
      "Checking current status does not reissue a cancellation",
    );
    assert.equal(
      await alex.evaluate(() => document.activeElement?.tagName),
      "H1",
    );
    await owner.goto(productUrl);
    await owner.getByText("2 available", { exact: true }).waitFor();
    record(
      "Unknown cancellation offers authoritative status check, never a misleading keep action; keyboard focus stays on the order heading",
    );
    record(
      "Only buyer can cancel unpaid reservation; lost response retry restores stock exactly once; buyer can reserve again",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(regressions, [], "Review-discovered edge cases");
    fs.writeFileSync(
      path.join(evidence, "results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          pageErrors: errors,
          taskUrl,
          productUrl,
          scope:
            "Disposable local fixture; real UI and DB; no live payment or mail",
        },
        null,
        2,
      ),
    );
    console.log(`PASS ${checks.length} checks; ${evidence}`);
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "failure.json"),
      JSON.stringify(
        { error: error.stack, checks, pageErrors: errors },
        null,
        2,
      ),
    );
    for (const [i, context] of contexts.entries())
      for (const page of context.pages())
        await page
          .screenshot({
            path: path.join(evidence, `failure-${i}.png`),
            fullPage: true,
          })
          .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})();
