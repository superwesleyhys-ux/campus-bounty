// Read-only focused verification after removing the internal revision counter from copy.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  fixtureSessionLogin,
  withFixture,
  origin,
} = require("./team-browser-support.cjs");
const input = process.env.CONVERSATION_ENGINEERING_FIXTURE;
assert.match(input || "", /^\.data\/qa\/round8-engineering-[\dTZ-]+\.json$/);
const seed = JSON.parse(fs.readFileSync(input));
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round8",
  `engineering-notification-finish-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  audits = [],
  errors = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let browser;
async function inbox(p) {
  await p.goto(`${origin}/?view=notifications`);
  await p
    .locator('[aria-label="Activity updates"][aria-busy="false"]')
    .waitFor();
}
async function notices(p) {
  return p.evaluate(async () =>
    (await fetch("/api/v1/notifications?limit=50")).json(),
  );
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  await withFixture(async (c) =>
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM campus.agreements WHERE id=$1 AND owner_id=$2 AND captain_id=$3",
          [seed.agreementId, seed.people[0].id, seed.people[1].id],
        )
      ).rows[0].n,
      1,
    ),
  );
  browser = await chromium.launch({ headless: true });
  const owner = await (await browser.newContext()).newPage();
  owner.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(owner, seed.people[0]);
  await inbox(owner);
  const page = await notices(owner),
    work = page.items.filter((n) => n.workContext);
  assert.equal(work.length, 3);
  assert.deepEqual(
    work
      .map((n) => [
        n.workContext.milestonePosition,
        n.workContext.submissionVersion,
      ])
      .sort(),
    [
      [1, 1],
      [1, 2],
      [2, 1],
    ],
  );
  for (const n of work) {
    const card = owner.locator(`[data-notification-id="${n.id}"]`);
    const text = await card.locator(".cb-notification-work").textContent();
    assert.match(
      text,
      new RegExp(
        `${n.workContext.milestoneTitle}.*Version ${n.workContext.submissionVersion}`,
      ),
    );
    assert.doesNotMatch(text, /Revision/);
    assert.equal(
      await card.locator(".cb-notification-context").textContent(),
      n.contextLabel,
    );
  }
  const legacy = page.items.find(
    (n) => n.kind === "milestone.submitted" && !n.workContext,
  );
  assert.ok(legacy);
  assert.equal(
    await owner
      .locator(`[data-notification-id="${legacy.id}"] .cb-notification-work`)
      .count(),
    0,
  );
  record(
    "Three exact stage/version event cards contain no internal revision counter; current project label and legacy generic copy retained",
  );
  for (const width of [320, 768, 1024, 1440]) {
    await owner.setViewportSize({ width, height: 1000 });
    await owner.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const audit = await owner.evaluate(async () => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      violations: (await axe.run()).violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
    }));
    audits.push({ width, ...audit });
    assert.equal(audit.overflow, false);
    assert.deepEqual(audit.violations, []);
    await owner.screenshot({
      path: path.join(output, `notifications-${width}.png`),
      fullPage: true,
    });
    await owner.screenshot({
      path: path.join(output, `notification-viewport-${width}.png`),
    });
  }
  record(
    "Final notification copy: four responsive widths and four axe audits clean",
  );
  for (const n of work) {
    await owner
      .locator(`[data-notification-id="${n.id}"]`)
      .getByRole("link", { name: "Open update" })
      .click();
    const id = `submission-${n.navigationAnchor.submissionId}`;
    await owner.waitForFunction((id) => document.activeElement?.id === id, id);
    assert.equal(await owner.locator(`[id="${id}"]`).isVisible(), true);
    if (
      n.workContext.submissionVersion === 1 &&
      n.workContext.milestonePosition === 1
    ) {
      assert.equal(
        await owner
          .locator(`[id="${id}"]`)
          .locator("xpath=..")
          .getAttribute("open"),
        "",
      );
      await owner.locator(`[id="${id}"]`).screenshot({
        path: path.join(output, "exact-historical-submission.png"),
      });
    }
    await inbox(owner);
  }
  assert.deepEqual(
    (await notices(owner)).items.map((n) => [n.id, n.readAt]),
    page.items.map((n) => [n.id, n.readAt]),
  );
  record(
    "All three submission links focus exact records; old version disclosure opens; all read states unchanged",
  );
  const captain = await (await browser.newContext()).newPage();
  captain.on("pageerror", (e) => errors.push(e.message));
  await fixtureSessionLogin(captain, seed.people[1]);
  await inbox(captain);
  const reviewed = (await notices(captain)).items.filter(
    (n) => n.navigationAnchor?.reviewId,
  );
  assert.equal(reviewed.length, 2);
  for (const n of reviewed) {
    await captain
      .locator(`[data-notification-id="${n.id}"]`)
      .getByRole("link", { name: "Open update" })
      .click();
    const id = `review-${n.navigationAnchor.reviewId}`;
    await captain.waitForFunction(
      (id) => document.activeElement?.id === id,
      id,
    );
    assert.equal(await captain.locator(`[id="${id}"]`).isVisible(), true);
    await inbox(captain);
  }
  record(
    "Two review event links retain exact review targets after final copy change",
  );
  assert.deepEqual(errors, []);
})()
  .catch((e) => {
    errors.push(e.stack);
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          run,
          checks,
          audits,
          errors,
          fixture: input,
          proof:
            "Read-only actual loopback browser over prior fresh engineering fixtures; real auth verifier excluding email delivery; no business writes.",
        },
        null,
        2,
      ),
    );
    console.log(`Evidence ${output}`);
  });
