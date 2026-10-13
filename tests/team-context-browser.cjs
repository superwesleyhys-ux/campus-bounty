// Round 5: real context UI, bounded to fresh synthetic loopback fixture accounts.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  origin,
  button,
  seedPeople,
  login,
  withFixture,
  fillTeamBackground,
  defaultTeamContext,
  fixtureSessionLogin,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const fixtureAuth = process.env.CAMPUS_CONTEXT_FIXTURE_AUTH === "1";
const output = path.resolve(
  "docs/evidence/interaction-round5",
  `browser-context-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  visualChecks = [],
  pageErrors = [];
const record = (check) => {
  checks.push(check);
  console.log(`PASS: ${check}`);
};
const card = (page, name) =>
  page
    .locator(".cb-team-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
const dialog = (page) => page.getByRole("dialog");
async function teams(page) {
  await page.goto(`${origin}/?view=teams`);
  await page
    .getByRole("heading", { name: "Your teams", exact: true })
    .waitFor();
}
async function api(page, route, body) {
  return page.evaluate(
    async ({ route, body, key }) => {
      const r = await fetch(
        `/api/v1/${route}`,
        body
          ? {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": key,
              },
              body: JSON.stringify(body),
            }
          : { cache: "no-store" },
      );
      const data = await r.json();
      if (!r.ok) throw Error(`${r.status}: ${JSON.stringify(data)}`);
      return data;
    },
    { route, body, key: randomUUID() },
  );
}
async function create(page, name, context) {
  await page.getByLabel("Team name", { exact: true }).fill(name);
  await fillTeamBackground(page, context);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/teams"),
  );
  await button(page, "Create team").click();
  const data = await (await response).json();
  await card(page, name).getByText(context.purpose, { exact: true }).waitFor();
  return data;
}
async function invite(page, name, person) {
  const target = card(page, name);
  await target.getByLabel("Teammate’s member code").fill(person.id);
  await button(target, "Check teammate").click();
  await button(target, `Invite ${person.name}`).click();
  await button(dialog(page), `Confirm: Invite ${person.name}`).click();
  await dialog(page).waitFor({ state: "hidden" });
  await target.getByText("invited", { exact: true }).waitFor();
}
async function edit(page, name, values) {
  await button(card(page, name), "Edit team background").click();
  await fillTeamBackground(dialog(page), values);
  await button(dialog(page), "Save team background").click();
  await dialog(page).waitFor({ state: "hidden" });
  await card(page, name).getByText(values.purpose, { exact: true }).waitFor();
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
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow ${name} at ${width}`,
    );
    await page.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
  }
  visualChecks.push({
    state: name,
    axeViolations: issues.length,
    issues,
    widths: [320, 768, 1024, 1440],
  });
  console.log(`${issues.length ? "A11Y FINDING" : "PASS VISUAL"}: ${name}`);
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const pages = [];
  try {
    const privateFolder = path.resolve(".data/qa/context-browser");
    const peopleFile = path.join(privateFolder, "people.json");
    const fixtureDatabase = JSON.parse(
      fs.readFileSync(".data/backend/interaction/fixture.json", "utf8"),
    ).database;
    const previous =
      fixtureAuth && fs.existsSync(peopleFile)
        ? JSON.parse(fs.readFileSync(peopleFile, "utf8"))
        : null;
    const people =
      previous?.database === fixtureDatabase
        ? previous.people
        : await seedPeople([
            "Context Captain",
            "Context Member",
            "Legacy Invitee",
          ]);
    if (fixtureAuth) {
      fs.mkdirSync(privateFolder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        peopleFile,
        JSON.stringify({ database: fixtureDatabase, people }),
        { mode: 0o600 },
      );
      fs.chmodSync(peopleFile, 0o600);
    }
    for (const person of people) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => pageErrors.push(e.message));
      pages.push(page);
      await (fixtureAuth ? fixtureSessionLogin : login)(page, person);
    }
    const [captain, member, legacy] = pages;
    const name = `Background team ${run}`;
    const context = {
      ...defaultTeamContext,
      purpose: "Plan a campus repair workshop <strong>together</strong>.",
      activities:
        "Meet every Tuesday at 5 pm.\nResearch repair methods and prepare a demo.",
      timeCommitment: "3 hours per week for six weeks.",
      projectContext:
        "The workshop is a proposal, not an accepted bounty agreement.",
    };
    await teams(captain);
    await captain
      .locator(".cb-panel")
      .filter({
        has: captain.getByRole("heading", {
          name: "Create a team",
          exact: true,
        }),
      })
      .getByText(
        "Team background is visible to current members and invited teammates.",
        { exact: true },
      )
      .waitFor();
    await captain.getByLabel("Team name", { exact: true }).fill(name);
    await fillTeamBackground(captain, { ...context, purpose: "   " });
    assert.ok(await button(captain, "Create team").isDisabled());
    const team = await create(captain, name, context);
    assert.deepEqual(team.context, context);
    assert.equal(
      await card(captain, name).locator(".cb-team-context strong").count(),
      0,
      "Context renders as text, not raw HTML",
    );
    record(
      "Create collects trimmed required purpose, schedule and time commitment; returned background is visible and HTML remains plain text",
    );
    await invite(captain, name, people[1]);
    await teams(member);
    for (const value of Object.values(context))
      await card(member, name).getByText(value, { exact: true }).waitFor();
    await card(member, name)
      .getByText(
        "Joining this team does not accept a bounty proposal or agreement. This background is informational and is not signed agreement terms.",
        { exact: true },
      )
      .waitFor();
    await audit(member, "invitation-background");
    record(
      "Invitee can read purpose, activities, time and optional background before deciding; joining is separate from signed terms",
    );

    await button(card(captain, name), "Edit team background").click();
    assert.equal(
      await captain.locator(":focus").getAttribute("name"),
      "purpose",
    );
    await captain.keyboard.press("Shift+Tab");
    assert.equal(
      await captain.locator(":focus").innerText(),
      "Save team background",
    );
    await captain.keyboard.press("Tab");
    assert.equal(
      await captain.locator(":focus").getAttribute("name"),
      "purpose",
    );
    await dialog(captain)
      .getByLabel("Team purpose", { exact: true })
      .fill("Unsaved draft");
    await captain.keyboard.press("Escape");
    await button(dialog(captain), "Keep editing").waitFor();
    await button(dialog(captain), "Keep editing").click();
    assert.equal(
      await dialog(captain)
        .getByLabel("Team purpose", { exact: true })
        .inputValue(),
      "Unsaved draft",
    );
    await button(dialog(captain), "Cancel editing").click();
    await button(dialog(captain), "Discard changes").click();
    await dialog(captain).waitFor({ state: "hidden" });
    assert.equal(
      await captain.locator(":focus").innerText(),
      "Edit team background",
    );
    await card(captain, name)
      .getByText(context.purpose, { exact: true })
      .waitFor();
    record(
      "Editor keyboard focus wraps; Escape protects dirty draft, Keep editing retains it, Discard restores focus and leaves server state unchanged",
    );

    await button(card(member, name), "Accept team invitation").click();
    const revised = {
      ...context,
      purpose: "Plan the expanded campus repair workshop.",
      timeCommitment: "4 hours per week for six weeks.",
    };
    await edit(captain, name, revised);
    const conflictResponse = member.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/teams/${team.id}/membership`),
    );
    await button(dialog(member), "Confirm: Accept team invitation").click();
    assert.equal((await conflictResponse).status(), 409);
    await button(dialog(member), "Close and review team").click();
    await card(member, name)
      .getByText(revised.timeCommitment, { exact: true })
      .waitFor();
    await button(card(member, name), "Accept team invitation").click();
    await button(dialog(member), "Confirm: Accept team invitation").click();
    await dialog(member).waitFor({ state: "hidden" });
    await member.goto(`${origin}/?view=workspace&tab=agreements`);
    await member
      .getByRole("heading", { name: "No agreements yet", exact: true })
      .waitFor();
    await member
      .getByText(
        "Joining a team does not create an agreement. Agreements appear here after a bounty invitation is accepted.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await member
        .getByRole("link", { name: "Open your workspace.", exact: true })
        .getAttribute("href"),
      "/?view=workspace",
    );
    await teams(member);
    record(
      "Background edit invalidates an open acceptance; server returns 409 and new background must be reviewed before acceptance",
    );

    await button(card(captain, name), "Edit team background").click();
    const draft = {
      ...revised,
      activities: "Draft: meet Thursday at noon instead.",
    };
    await fillTeamBackground(dialog(captain), draft);
    const other = await captain.context().newPage();
    pages.push(other);
    await teams(other);
    const remote = {
      ...revised,
      purpose: "Latest saved purpose from the other captain session.",
    };
    await edit(other, name, remote);
    const editConflict = captain.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/teams/${team.id}/context`),
    );
    await button(dialog(captain), "Save team background").click();
    assert.equal((await editConflict).status(), 409);
    await dialog(captain).getByText(remote.purpose, { exact: true }).waitFor();
    await captain.waitForFunction(() => {
      const focused = document.activeElement;
      if (!focused?.matches("dialog .cb-alert[role='alert'][tabindex='-1']"))
        return false;
      const box = focused.getBoundingClientRect();
      return box.top >= 0 && box.top < innerHeight && box.bottom > 0;
    });
    assert.equal(
      await dialog(captain)
        .getByLabel("Activities and schedule", { exact: true })
        .inputValue(),
      draft.activities,
    );
    assert.ok(
      await button(dialog(captain), "Save team background").isDisabled(),
    );
    await button(
      dialog(captain),
      "Use latest version and review draft",
    ).click();
    await button(dialog(captain), "Save team background").click();
    await dialog(captain).waitFor({ state: "hidden" });
    record(
      "Concurrent captain edit retains unsaved draft, shows current saved background, and requires explicit latest-version review before saving",
    );

    await button(card(captain, name), "Edit team background").click();
    const final = {
      ...draft,
      projectContext:
        "Saved after an interrupted response; still informational.",
    };
    await fillTeamBackground(dialog(captain), final);
    const before = await api(captain, `teams/${team.id}`),
      keys = [];
    const track = (req) => {
      if (
        req.method() === "POST" &&
        req.url().endsWith(`/teams/${team.id}/context`)
      )
        keys.push(req.headers()["idempotency-key"]);
    };
    captain.on("request", track);
    await captain.route(
      `**/api/v1/teams/${team.id}/context`,
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await button(dialog(captain), "Save team background").click();
    await button(dialog(captain), "Retry same background update").waitFor();
    assert.ok(
      await dialog(captain)
        .getByLabel("Team purpose", { exact: true })
        .isDisabled(),
    );
    assert.equal(await button(dialog(captain), "Cancel editing").count(), 0);
    await button(dialog(captain), "Check saved background").click();
    await dialog(captain)
      .getByText(
        "These are the current saved values. They do not establish whether your original request completed. Retry the same update to resolve the request.",
        { exact: true },
      )
      .waitFor();
    await audit(captain, "unknown-background-update");
    await button(dialog(captain), "Retry same background update").click();
    await dialog(captain).waitFor({ state: "hidden" });
    const after = await api(captain, `teams/${team.id}`);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.context, final);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    captain.off("request", track);
    record(
      "Committed background update with lost response freezes inputs; GET is described as current state only, same-key retry resolves with one revision increment",
    );

    await member.reload();
    await button(card(member, name), "Leave team").click();
    await button(dialog(member), "Confirm: Leave team").click();
    await dialog(member).waitFor({ state: "hidden" });
    assert.equal((await api(member, `teams/${team.id}`)).context, null);
    assert.equal(
      await card(member, name).locator(".cb-team-context").count(),
      0,
    );
    assert.equal(
      await card(member, name)
        .getByText(final.purpose, { exact: true })
        .count(),
      0,
    );
    record(
      "After leaving, API context is null and the UI retains relationship history without team background",
    );

    const legacyName = `Legacy background ${run}`;
    const old = await api(captain, "teams", { name: legacyName });
    // Synthetic legacy-state setup only: this is not an actual upgrade test.
    // Scope the temporary context to this one fixture team; never disable triggers.
    await withFixture(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          "UPDATE campus.team_contexts SET purpose='Fixture setup', activities='Fixture setup', time_commitment='Fixture setup' WHERE team_id=$1",
          [old.id],
        );
        await client.query(
          "INSERT INTO campus.team_members(team_id,user_id,state) VALUES($1,$2,'invited')",
          [old.id, people[2].id],
        );
        await client.query(
          "UPDATE campus.team_contexts SET purpose='', activities='', time_commitment='' WHERE team_id=$1",
          [old.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    await teams(captain);
    await button(card(captain, legacyName), "Add team background").waitFor();
    assert.equal(
      await button(card(captain, legacyName), "Check teammate").count(),
      0,
    );
    await teams(legacy);
    await card(legacy, legacyName)
      .getByText(
        "Not provided. Ask the captain for this information before deciding to join.",
        { exact: true },
      )
      .first()
      .waitFor();
    assert.equal(
      await card(legacy, legacyName)
        .getByText(
          "Not provided. Ask the captain for this information before deciding to join.",
          { exact: true },
        )
        .count(),
      3,
    );
    await button(card(legacy, legacyName), "Accept team invitation").click();
    await button(dialog(legacy), "Confirm: Accept team invitation").click();
    await dialog(legacy).waitFor({ state: "hidden" });
    await captain.reload();
    await button(card(captain, legacyName), "Add team background").click();
    await fillTeamBackground(dialog(captain));
    await button(dialog(captain), "Save team background").click();
    await dialog(captain).waitFor({ state: "hidden" });
    await button(card(captain, legacyName), "Check teammate").waitFor();
    record(
      "Legacy pending invite explicitly shows missing information and remains acceptable; captain is guided to add background before new invitations",
    );
    await audit(captain, "saved-background-and-legacy");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(
      visualChecks.flatMap((check) => check.issues),
      [],
      "Accessibility findings must be resolved",
    );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          passed: true,
          businessChecks: checks.length,
          checks,
          visualChecks,
          pageErrors,
          scope:
            "Synthetic engineering accounts in disposable loopback fixture; real UI/API; legacy pending row created only in a scoped fixture transaction, not an upgrade test",
          authentication: fixtureAuth
            ? "Cached fixture sessions or real auth.verify on synthetic seeded challenges; OTP delivery excluded from this context UI run; rate limits unchanged"
            : "OTP login through real UI",
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS ${checks.length} business checks, ${visualChecks.length} visual states; ${output}`,
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify(
        { passed: false, error: error.stack, checks, visualChecks, pageErrors },
        null,
        2,
      ),
    );
    for (const [i, page] of pages.entries())
      await page
        .screenshot({
          path: path.join(output, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
