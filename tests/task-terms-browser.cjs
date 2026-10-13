// Run only against scripts/interaction-preview.mjs and its synthetic local mail.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const origin = process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3020";
if (new URL(origin).hostname !== "127.0.0.1")
  throw new Error("Loopback fixture only");
const evidence = path.resolve("docs/evidence/task-terms");
fs.mkdirSync(evidence, { recursive: true });
const checks = [];
const errors = [];
const record = (check, details = {}) => checks.push({ check, ...details });
async function signIn(page, name) {
  await page.goto(origin);
  await page
    .getByLabel("University email", { exact: true })
    .fill(`${name}@campus.example.test`);
  const started = Date.now();
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await page.getByLabel("Sign-in code", { exact: true }).waitFor();
  const mail = path.resolve(`.data/backend/interaction/${name}.txt`);
  let code;
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(mail) && fs.statSync(mail).mtimeMs >= started) {
      code = fs
        .readFileSync(mail, "utf8")
        .match(/verification code is (\d{6})/)?.[1];
      if (code) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(code, "Synthetic local message arrived");
  await page.getByLabel("Sign-in code", { exact: true }).fill(code);
  await page
    .getByLabel("Your display name")
    .fill(name === "professor" ? "Professor" : "Alex");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
async function audit(page, label) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () =>
    (await axe.run()).violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      count: nodes.length,
    })),
  );
  assert.deepEqual(violations, [], `axe ${label}`);
  const widths = [];
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const size = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.width,
      `${label} overflows at ${width}: ${size.scroll}`,
    );
    widths.push(size);
  }
  record(label, { axeViolations: violations.length, widths });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const owner = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "America/Los_Angeles",
    });
    const student = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "Pacific/Kiritimati",
    });
    const p = await owner.newPage(),
      a = await student.newPage();
    for (const page of [p, a])
      page.on("pageerror", (e) => errors.push(e.message));
    await signIn(p, "professor");
    const me = await (await p.request.get(`${origin}/api/v1/me`)).json();
    // Reproduce a draft saved by the previous version: no date or criteria.
    await p.evaluate(
      ({ id }) =>
        localStorage.setItem(
          `campus:draft:${id}:task`,
          JSON.stringify({
            title: "Restored research draft",
            description: "Document a campus survey with reproducible results.",
            category: "Research",
            amount: "125",
            stock: "1",
            pickup: true,
            shipping: false,
            shippingAmount: "0",
            milestones: [
              {
                title: "Research report",
                deliverable: "A report and source notebook.",
                amount: "125",
              },
            ],
          }),
        ),
      me,
    );
    await p.goto(`${origin}/?view=publish&kind=task`);
    await p.getByLabel("Title", { exact: true }).waitFor();
    assert.equal(
      await p.getByLabel("Title", { exact: true }).inputValue(),
      "Restored research draft",
    );
    assert.equal(await p.getByLabel("Target delivery date").inputValue(), "");
    const title = `Task terms browser check ${Date.now()}`;
    await p.getByLabel("Title", { exact: true }).fill(title);
    await p.getByLabel("Target delivery date").fill("2027-04-30");
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    const criteria =
      "Include all 120 survey records.\nExplain missing values and make the notebook reproducible.";
    const criteriaField = p.getByLabel("Acceptance criteria", { exact: true });
    assert.equal(await criteriaField.inputValue(), "");
    await criteriaField.fill("   ");
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p
      .getByText("Add acceptance criteria for milestone 1.", { exact: true })
      .waitFor();
    await criteriaField.fill(criteria);
    await p.getByRole("button", { name: "Save draft", exact: true }).click();
    await p.goto(`${origin}/?view=teams`);
    await p.goto(`${origin}/?view=publish&kind=task`);
    assert.equal(
      await p.getByLabel("Target delivery date").inputValue(),
      "2027-04-30",
    );
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(
      await p.getByLabel("Acceptance criteria", { exact: true }).inputValue(),
      criteria,
    );
    record("Legacy drafts preserved; new terms required, saved and restored");
    await audit(p, "Publishing form");
    await p.setViewportSize({ width: 320, height: 1000 });
    await p.screenshot({
      path: path.join(evidence, "publishing-mobile.png"),
      fullPage: true,
    });
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByText("April 30, 2027", { exact: true }).waitFor();
    await p
      .getByRole("button", { name: "Publish listing", exact: true })
      .click();
    await p.waitForURL(
      (url) =>
        url.searchParams.get("view") === "bounties" &&
        !!url.searchParams.get("id"),
    );
    await p
      .getByRole("heading", { name: title, exact: true, level: 1 })
      .waitFor();
    const taskId = new URL(p.url()).searchParams.get("id");
    assert.ok(taskId);
    const task = await (
      await p.request.get(`${origin}/api/v1/tasks/${taskId}`)
    ).json();
    assert.equal(task.due_date, "2027-04-30");
    assert.equal(task.milestones[0].acceptance_criteria, criteria);
    await audit(p, "Published task detail");
    await p.screenshot({
      path: path.join(evidence, "task-detail-desktop.png"),
      fullPage: true,
    });
    await signIn(a, "alex");
    await a.goto(`${origin}/?view=bounties&id=${taskId}`);
    await a.getByText("April 30, 2027", { exact: true }).waitFor();
    await a
      .getByLabel("Your proposal")
      .fill("I will deliver all survey records and the reproducible notebook.");
    await a
      .getByRole("button", { name: "Send application", exact: true })
      .click();
    await a
      .getByText(
        "I will deliver all survey records and the reproducible notebook.",
        { exact: true },
      )
      .waitFor();
    await p.reload();
    await p
      .getByRole("button", { name: "Invite this applicant", exact: true })
      .click();
    await p
      .getByText("Invitation sent. The applicant must accept it.", {
        exact: true,
      })
      .waitFor();
    await a.goto(`${origin}/?view=workspace&tab=applications`);
    const proposal = a
      .locator("section")
      .filter({ has: a.getByRole("link", { name: title, exact: true }) });
    await proposal
      .getByRole("button", { name: "Review invitation", exact: true })
      .click();
    await proposal.getByText("April 30, 2027", { exact: true }).waitFor();
    assert.ok((await proposal.innerText()).includes("Explain missing values"));
    await audit(a, "Workspace invitation review");
    await a.screenshot({
      path: path.join(evidence, "invitation-review.png"),
      fullPage: true,
    });
    await proposal
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await a.getByText("Waiting for funding", { exact: true }).waitFor();
    await a.getByText("April 30, 2027", { exact: true }).waitFor();
    const agreementId = new URL(a.url()).searchParams.get("id");
    const agreement = await (
      await a.request.get(`${origin}/api/v1/agreements/${agreementId}`)
    ).json();
    assert.equal(agreement.terms.dueDate, "2027-04-30");
    assert.equal(agreement.milestones[0].acceptance_criteria, criteria);
    assert.equal(agreement.state, "awaiting_funding");
    assert.equal(
      await a
        .getByRole("button", { name: "Submit for review", exact: true })
        .isDisabled(),
      true,
    );
    record(
      "Publish → apply → invite → Workspace review → accept preserves exact date and criteria across time zones; funding gate remains",
    );
    await audit(a, "Agreement terms");
    await a.screenshot({
      path: path.join(evidence, "agreement.png"),
      fullPage: true,
    });
    // Goods still use their own delivery fields; task fields must not leak in.
    await p.goto(`${origin}/?view=publish&kind=product`);
    await p
      .getByLabel("Title", { exact: true })
      .fill("Task-terms regression book");
    await p
      .getByLabel("Description", { exact: true })
      .fill("A synthetic paperback for browser testing.");
    await p.getByLabel("Price per item (USD)").fill("18");
    await p.getByLabel("Available quantity").fill("2");
    assert.equal(await p.getByLabel("Target delivery date").count(), 0);
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p
      .getByRole("button", { name: "Publish listing", exact: true })
      .click();
    await p.waitForURL(
      (url) =>
        url.searchParams.get("view") === "market" &&
        !!url.searchParams.get("id"),
    );
    await p
      .getByRole("heading", {
        name: "Task-terms regression book",
        exact: true,
        level: 1,
      })
      .waitFor();
    record(
      "Physical goods publishing remains operational without task-only terms",
    );
    assert.deepEqual(errors, [], "No page runtime errors");
    fs.writeFileSync(
      path.join(evidence, "browser-results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          pageErrors: errors,
          scope:
            "Synthetic local PostgreSQL fixture, two isolated browser contexts; no live email/payment",
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS: ${checks.length} browser checks; screenshots and results in docs/evidence/task-terms`,
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(evidence, "browser-failure.json"),
      JSON.stringify(
        {
          passed: false,
          completedChecks: checks,
          error: error.message,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
