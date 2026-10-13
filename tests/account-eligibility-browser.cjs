// Real UI checks against the disposable local fixture. No external accounts.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const pg = require("pg");
const origin = "http://127.0.0.1:3020";
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidence = path.resolve(
  `docs/evidence/interaction-round3/browser-${stamp}`,
);
fs.mkdirSync(evidence, { recursive: true });
const checks = [],
  errors = [];
const button = (page, name) => page.getByRole("button", { name, exact: true });
const record = (check, details = {}) => checks.push({ check, ...details });

async function seed() {
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const fixture = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const url = connectionString(localConfig(), "migrator", fixture.database);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const people = [
    {
      id: randomUUID(),
      emailName: `student-${suffix}`,
      name: "Existing student",
    },
    {
      id: randomUUID(),
      emailName: `reviewer-${suffix}`,
      name: "Synthetic reviewer",
    },
  ];
  try {
    await client.query("BEGIN");
    const { institution_id } = (
      await client.query(
        "SELECT institution_id FROM campus.domains WHERE domain='campus.example.test' AND enabled",
      )
    ).rows[0];
    for (const person of people) {
      await client.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
        [person.id, person.name],
      );
      await client.query(
        "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until) VALUES($1,$2,'campus.example.test',now()+interval '180 days')",
        [person.id, institution_id],
      );
      await client.query(
        "INSERT INTO campus.identities(email,user_id,domain,verified_at) VALUES($1,$2,'campus.example.test',now())",
        [`${person.emailName}@campus.example.test`, person.id],
      );
    }
    await client.query(
      "INSERT INTO campus.eligibility_reviewers(user_id,institution_id) VALUES($1,$2)",
      [people[1].id, institution_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
  return { people, fixture };
}
async function login(page, person) {
  await page.goto(origin);
  await page
    .getByLabel("University email", { exact: true })
    .fill(`${person.emailName}@campus.example.test`);
  const start = Date.now();
  await button(page, "Email me a sign-in code").click();
  await page.getByLabel("Sign-in code", { exact: true }).waitFor();
  const mail = `.data/backend/interaction/${person.emailName}.txt`;
  let code;
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(mail) && fs.statSync(mail).mtimeMs >= start)
      code = fs
        .readFileSync(mail, "utf8")
        .match(/verification code is (\d{6})/)?.[1];
    if (code) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(code, "Local synthetic code received");
  await page.getByLabel("Sign-in code", { exact: true }).fill(code);
  await page
    .getByLabel("Your display name", { exact: true })
    .fill("Name typed during login");
  await button(page, "Verify and continue").click();
  await button(page, "Sign out").waitFor();
}
async function audit(page, name) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const issues = await page.evaluate(async () =>
    (await axe.run()).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
    })),
  );
  assert.deepEqual(issues, [], name);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} overflow ${width}`,
    );
    for (const checkbox of await page.getByRole("checkbox").all()) {
      const bounds = await checkbox.boundingBox();
      if (bounds)
        assert.ok(
          bounds.width >= 20 && bounds.height >= 20,
          `${name} checkbox must not shrink at ${width}`,
        );
    }
    if (width === 320)
      await page.screenshot({
        path: path.join(evidence, `${name}-mobile.png`),
        fullPage: true,
      });
  }
  await page.screenshot({
    path: path.join(evidence, `${name}.png`),
    fullPage: true,
  });
  record(name, { axeViolations: 0, widths: [320, 768, 1024, 1440] });
}
async function requestReview(page, summary, loseResponse = false) {
  await page.getByLabel("Current enrollment information").fill(summary);
  await page
    .getByRole("checkbox", { name: /^I confirm that this enrollment/ })
    .check();
  if (loseResponse)
    await page.route("**/api/v1/me/eligibility-requests", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
  await button(page, "Submit review request").click();
  if (loseResponse) {
    await page.locator(".cb-error[role=alert]").waitFor();
    await page.unroute("**/api/v1/me/eligibility-requests");
    await button(page, "Refresh eligibility status").click();
    await page
      .getByText(
        "Your request was received. Its current status is shown below.",
        { exact: true },
      )
      .waitFor();
    record(
      "Lost eligibility submission response recovers the existing request via status refresh",
    );
  }
  await page
    .getByText("Your request is waiting for review.", { exact: false })
    .waitFor();
}
async function decide(page, summary, decision, reason) {
  await page.goto(`${origin}/?view=eligibility-review`);
  const card = page
    .locator("article")
    .filter({ has: page.getByText(summary, { exact: true }) });
  await card.getByLabel("Decision", { exact: true }).selectOption(decision);
  await card.getByLabel("Review explanation").fill(reason);
  if (decision === "approved") {
    const date = new Date(Date.now() + 30 * 86400000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    await card
      .getByLabel("Student approval valid until")
      .fill(date.toISOString().slice(0, 16));
  }
  await button(card, "Review decision").click();
  await audit(page, `${decision}-confirmation`);
  let decisionPosts = 0;
  const observe = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/decision"))
      decisionPosts++;
  };
  if (decision === "approved") {
    page.on("request", observe);
    await page.route(
      "**/api/v1/admin/eligibility-requests/*/decision",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
    );
  }
  await button(card, "Confirm decision").click();
  if (decision === "approved") {
    await card.locator(".cb-error[role=alert]").waitFor();
    await page.unroute("**/api/v1/admin/eligibility-requests/*/decision");
    await button(card, "Check current status").click();
    await card
      .getByText("The recorded decision is approved.", { exact: false })
      .waitFor();
    await card.getByText("approved", { exact: true }).waitFor();
    assert.equal(
      decisionPosts,
      1,
      "Status recovery performs no second decision POST",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "H2",
    );
    assert.equal(await button(card, "Confirm decision").count(), 0);
    page.off("request", observe);
    await audit(page, "approval-result-recovery");
    record(
      "Lost decision response recovers its exact approved result with GET only and keeps focus on the request",
    );
    return;
  }
  await page
    .getByText(`The decision and explanation are saved.`, { exact: false })
    .waitFor();
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  const pages = [];
  try {
    const { people, fixture } = await seed();
    for (const person of people) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "en-GB",
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await login(page, person);
    }
    const [student, reviewer] = pages;
    await student
      .locator(".cb-account-line")
      .getByText("Existing student", { exact: true })
      .waitFor();
    await student.getByRole("link", { name: "Account", exact: true }).click();
    await student
      .getByText("University email verified until", { exact: false })
      .waitFor();
    const membershipDate = (
      await student
        .getByText("Email verification valid until", { exact: false })
        .innerText()
    ).match(/until (.+)\.$/)[1];
    const eligibilityDate = (
      await student
        .getByText("University email verified until", { exact: false })
        .innerText()
    ).match(/until (.+)\. Student/)[1];
    assert.equal(
      membershipDate,
      eligibilityDate,
      "Same timestamp uses the same format in both account sections",
    );
    assert.match(
      membershipDate,
      /[A-Za-z]{3} \d{1,2}, \d{4}/,
      "Date uses a month name instead of ambiguous numbers",
    );
    record(
      "Account dates use consistent month names and time-zone labels with an en-GB browser locale",
    );
    await student
      .getByLabel("Display name", { exact: true })
      .fill("Rowan Chen");
    await student
      .getByLabel("Short bio")
      .fill("I study ecology and enjoy organizing field observations.");
    await button(student, "Save profile").click();
    await student.getByText("Profile saved.", { exact: true }).waitFor();
    await student.reload();
    assert.equal(
      await student.getByLabel("Display name", { exact: true }).inputValue(),
      "Rowan Chen",
    );
    await student
      .locator(".cb-account-line")
      .getByText("Rowan Chen", { exact: true })
      .waitFor();
    record(
      "Returning login retains saved name; profile edits persist and update account identity",
    );
    await student
      .getByLabel("Short bio")
      .fill(
        "A synthetic response-loss check; these profile details should be saved once.",
      );
    await student.route("**/api/v1/me", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
    await button(student, "Save profile").click();
    await student.locator(".cb-error[role=alert]").waitFor();
    await student.unroute("**/api/v1/me");
    assert.equal(await button(student, "Discard changes").count(), 0);
    await button(student, "Retry the same save").click();
    await student.getByText("Profile saved.", { exact: true }).waitFor();
    await audit(student, "account-profile");
    record(
      "Profile save recovers when the write succeeds but its response is lost",
    );
    await student
      .getByLabel("Short bio")
      .fill(
        "A second saved profile, recovered through a read-only status check.",
      );
    await student.route("**/api/v1/me", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
    await button(student, "Save profile").click();
    await student.locator(".cb-error[role=alert]").waitFor();
    await student.unroute("**/api/v1/me");
    await button(student, "Check current profile").click();
    await student
      .getByText(
        "Your changes are saved. The current profile matches these entries.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await student.evaluate(() => document.activeElement?.id),
      "profile-heading",
    );
    record(
      "Profile uncertainty also resolves through current-state readback with focus preserved",
    );
    await student.goto(`${origin}/?view=eligibility-review`);
    await student
      .getByText("You do not have permission", { exact: false })
      .waitFor();
    assert.equal(
      (
        await student.request.get(`${origin}/api/v1/admin/eligibility-requests`)
      ).status(),
      403,
    );
    record("Ordinary member cannot view review queue in UI or API");
    const taskUrl = `${origin}/?view=bounties&id=${fixture.tasks[1]}`;
    await student.goto(taskUrl);
    await student
      .getByRole("link", { name: "Check student eligibility", exact: true })
      .last()
      .click();
    await student.locator("#student-eligibility").waitFor();
    assert.equal(
      await student.evaluate(() => document.activeElement?.id),
      "student-eligibility",
    );
    const summary1 = `Currently studying ecology in the fall term. Synthetic request ${stamp}.`;
    await requestReview(student, summary1, true);
    await audit(student, "pending-request");
    await decide(
      reviewer,
      summary1,
      "rejected",
      "Please include your current program and expected completion term.",
    );
    await button(student, "Refresh eligibility status").click();
    await student
      .getByText("Your request was not approved.", { exact: true })
      .waitFor();
    const summary2 = `${summary1} Bachelor of Environmental Science, expected spring 2028.`;
    await requestReview(student, summary2);
    await decide(
      reviewer,
      summary2,
      "approved",
      "Synthetic review: current enrollment checked for this local test.",
    );
    await button(student, "Refresh eligibility status").click();
    await student
      .getByText("You can apply to bounties and join teams.", { exact: false })
      .waitFor();
    await audit(student, "approved-history");
    assert.equal(
      await student.locator("#student-eligibility article").count(),
      2,
    );
    record(
      "Request -> review rejection -> revised request -> approval preserves both records and reasons",
    );
    await student.goto(taskUrl);
    const proposal = `Synthetic newly approved student proposal ${stamp}`;
    await student.getByLabel("Your proposal").fill(proposal);
    await button(student, "Send application").click();
    await student
      .locator("article")
      .getByText(proposal, { exact: true })
      .waitFor();
    record("Approved student can complete an actual bounty application");
    await student.goto(`${origin}/?view=market`);
    await student
      .getByRole("link", {
        name: "Introduction to Algorithms — fourth edition",
        exact: true,
      })
      .click();
    await student
      .getByRole("heading", {
        level: 1,
        name: "Introduction to Algorithms — fourth edition",
        exact: true,
      })
      .waitFor();
    record("Marketplace product title opens the item details");
    assert.deepEqual(errors, [], "No browser page errors");
    fs.writeFileSync(
      path.join(evidence, "results.json"),
      JSON.stringify(
        { checks, errors, syntheticUserIds: people.map((p) => p.id) },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ result: "pass", checks: checks.length, evidence }),
    );
  } catch (error) {
    for (let i = 0; i < pages.length; i++)
      await pages[i]
        .screenshot({
          path: path.join(evidence, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
    fs.writeFileSync(
      path.join(evidence, "failure.json"),
      JSON.stringify(
        { message: error.message, stack: error.stack, checks, errors },
        null,
        2,
      ),
    );
    console.error(
      JSON.stringify({ result: "fail", message: error.message, evidence }),
    );
    process.exitCode = 1;
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
})();
