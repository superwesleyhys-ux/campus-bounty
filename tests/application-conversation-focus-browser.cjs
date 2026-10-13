// Focus/current-author regression for final Task 3 self-review change.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  withFixture,
  fixtureSessionLogin,
  origin,
  button,
} = require("./team-browser-support.cjs");
const seed = JSON.parse(fs.readFileSync(process.env.R10_RESUME_FIXTURE));
const output = path.resolve(
  "docs/evidence/interaction-round10",
  `task-3-focus-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  errors = [];
let browser;
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const ready = (p) =>
  conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  browser = await chromium.launch({ headless: true });
  const p = await browser.newPage();
  p.on("pageerror", (e) => errors.push(e.stack));
  await fixtureSessionLogin(p, seed.people[1]);
  for (const [id, closed] of [
    [seed.otherApp.id, false],
    [seed.primary.id, true],
    [seed.acceptedApp.id, true],
  ]) {
    await p.goto(
      `${origin}/?view=workspace&tab=applications&resource=application&id=${id}`,
    );
    await ready(p);
    await p.getByLabel("Message", { exact: true }).fill("Final focus draft");
    await button(p, "Refresh messages").focus();
    await p.keyboard.press("Enter");
    await ready(p);
    await p.waitForFunction(() =>
      document.activeElement?.hasAttribute("data-refresh-messages"),
    );
    assert.ok(
      await button(p, "Refresh messages").evaluate(
        (n) => n === document.activeElement,
      ),
    );
    assert.equal(
      await p.getByLabel("Message", { exact: true }).inputValue(),
      "Final focus draft",
    );
    assert.equal(await button(p, "Send message").isEnabled(), !closed);
    await p.keyboard.press("Tab");
    assert.ok(await p.evaluate(() => document.activeElement !== document.body));
    checks.push(
      `Refresh restores keyboard focus and scoped draft: ${closed ? "closed" : "open"} ${id === seed.acceptedApp.id ? "accepted" : ""}`,
    );
  }
  await withFixture((c) =>
    c.query("UPDATE campus.users SET display_name=$2 WHERE id=$1", [
      seed.people[2].id,
      "R10 Current edited participant",
    ]),
  );
  await p.goto(
    `${origin}/?view=workspace&tab=applications&resource=application&id=${seed.primary.id}`,
  );
  await ready(p);
  assert.match(
    await conv(p)
      .getByRole("list", { name: "Conversation participants" })
      .textContent(),
    /R10 Current edited participant/,
  );
  assert.match(
    await conv(p).locator("[data-message-id]").last().textContent(),
    /R10 Current edited participant/,
  );
  checks.push(
    "Old messages and frozen roster render current edited author name",
  );
  await withFixture((c) =>
    c.query("UPDATE campus.users SET display_name=$2 WHERE id=$1", [
      seed.people[2].id,
      seed.people[2].name,
    ]),
  );
  assert.deepEqual(errors, []);
  checks.forEach((n) => console.log("PASS " + n));
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
      JSON.stringify({ checks, errors }, null, 2),
    );
    console.log("Evidence " + output);
  });
