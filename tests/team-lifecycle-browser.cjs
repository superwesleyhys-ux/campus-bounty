// Real browser regression. All data is seeded only in the existing disposable loopback fixture.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  origin,
  button,
  seedPeople,
  withFixture,
  login,
  fillTeamBackground,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidence = path.resolve(
  "docs/evidence/interaction-round4",
  `browser-${run}`,
);
fs.mkdirSync(evidence, { recursive: true });
const checks = [],
  errors = [];
const record = (check, details = {}) => {
  checks.push({ check, ...details });
  console.log(`PASS: ${check}`);
};
const teamName = `Lifecycle team ${run}`;
const teamCard = (page) =>
  page.locator("article.cb-team-card").filter({
    has: page.getByRole("heading", { name: teamName, exact: true }),
  });
const row = (page, name) =>
  teamCard(page)
    .locator("li")
    .filter({ has: page.getByText(name, { exact: true }) });
async function teams(page) {
  await page.goto(`${origin}/?view=teams`);
  await page
    .getByRole("heading", { name: "Your teams", exact: true })
    .waitFor();
}
async function settle(page) {
  await button(teamCard(page), "Refresh team").waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (el) => el.textContent === "Refresh team" && !el.disabled,
    ),
  );
}
async function state(page, name, value) {
  await row(page, name).getByText(value, { exact: true }).waitFor();
  await settle(page);
}
async function action(page, label, scope = teamCard(page)) {
  await button(scope, label).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await button(dialog, `Confirm: ${label}`).click();
  await dialog.waitFor({ state: "hidden" });
  await settle(page);
}
async function invite(page, person) {
  await settle(page);
  await teamCard(page).getByLabel("Teammate’s member code").fill(person.id);
  await button(teamCard(page), "Check teammate").click();
  await action(page, `Invite ${person.name}`);
  await state(page, person.name, "invited");
}
async function audit(page, name) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () =>
    (await axe.run()).violations.map((value) => ({
      id: value.id,
      impact: value.impact,
      count: value.nodes.length,
    })),
  );
  assert.deepEqual(violations, [], `axe ${name}`);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name}: overflow at ${width}`,
    );
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}.png`),
      fullPage: true,
    });
  }
  record(name, { axeViolations: 0, widths: [320, 768, 1024, 1440] });
}
async function publish(page, title) {
  await page.goto(`${origin}/?view=publish&kind=task`);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Synthetic team snapshot verification. No live work or payment.");
  await page.getByLabel("Total bounty reward (USD)").fill("100");
  await page.getByLabel("Target delivery date").fill("2027-04-30");
  await button(page, "Continue").click();
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
  await button(page, "Continue").click();
  await button(page, "Publish listing").click();
  await page.waitForURL((url) => !!url.searchParams.get("id"));
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  return page.url();
}
async function json(page, apiPath) {
  return page.evaluate(async (value) => {
    const response = await fetch(`/api/v1/${value}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw Error(`Readback failed: ${response.status}`);
    return response.json();
  }, apiPath);
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const pages = [],
    contexts = [];
  try {
    const people = await seedPeople([
      "Round Four Captain",
      "Round Four Member",
      "Round Four Third",
      "Round Four Publisher",
    ]);
    for (const person of people) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      pages.push(page);
      await login(page, person);
    }
    const [captain, member, third, publisher] = pages;
    await teams(captain);
    await captain.getByLabel("Team name", { exact: true }).fill(teamName);
    await fillTeamBackground(captain);
    const created = captain.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/v1/teams"),
    );
    await button(captain, "Create team").click();
    const teamId = (await (await created).json()).id;
    assert.ok(teamId);
    await settle(captain);
    record("Create team through UI");
    await invite(captain, people[1]);
    await teams(member);
    await state(member, "You", "invited");
    await button(teamCard(member), "Decline invitation").click();
    assert.equal(
      await member.getByRole("dialog").locator(".cb-team-commitments").count(),
      0,
    );
    assert.equal(await member.locator(":focus").innerText(), "Cancel");
    await member.keyboard.press("Tab");
    assert.equal(
      await member.locator(":focus").innerText(),
      "Confirm: Decline invitation",
    );
    await member.keyboard.press("Tab");
    assert.equal(await member.locator(":focus").innerText(), "Cancel");
    await member.keyboard.press("Escape");
    assert.equal(
      await member.locator(":focus").innerText(),
      "Decline invitation",
    );
    await action(member, "Decline invitation");
    await state(member, "You", "declined");
    assert.equal(await row(member, people[0].name).count(), 0);
    await captain.reload();
    await invite(captain, people[1]);
    await member.reload();
    await action(member, "Accept team invitation");
    await state(member, "You", "accepted");
    record(
      "Invitation decline, terminal roster privacy, re-invitation and acceptance; keyboard focus trap, Escape and return",
    );

    await captain.reload();
    await invite(captain, people[2]);
    await button(row(captain, people[2].name), "Revoke invitation").click();
    // Independent synthetic change after confirmation opened proves version conflict handling.
    await withFixture((client) =>
      client.query("UPDATE campus.teams SET revision=revision+1 WHERE id=$1", [
        teamId,
      ]),
    );
    const conflict = captain.waitForResponse(
      (response) =>
        response.url().endsWith(`/members/${people[2].id}/revoke`) &&
        response.request().method() === "POST",
    );
    await button(
      captain.getByRole("dialog"),
      "Confirm: Revoke invitation",
    ).click();
    assert.equal((await conflict).status(), 409);
    await button(
      captain.getByRole("dialog"),
      "Close and review team",
    ).waitFor();
    assert.ok(
      await button(
        captain.getByRole("dialog"),
        "Confirm: Revoke invitation",
      ).isDisabled(),
    );
    await button(captain.getByRole("dialog"), "Close and review team").click();
    await action(captain, "Revoke invitation", row(captain, people[2].name));
    await state(captain, people[2].name, "revoked");
    record(
      "Outdated revision returns 409; stale confirmation disabled until refreshed and chosen again; revoke succeeds",
    );

    let invitationPosts = 0;
    const countInvite = (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/teams/${teamId}/invitations`)
      )
        invitationPosts++;
    };
    captain.on("request", countInvite);
    await captain.route(
      `**/api/v1/teams/${teamId}/invitations`,
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await teamCard(captain)
      .getByLabel("Teammate’s member code")
      .fill(people[2].id);
    await button(teamCard(captain), "Check teammate").click();
    await button(teamCard(captain), `Invite ${people[2].name}`).click();
    await button(
      captain.getByRole("dialog"),
      `Confirm: Invite ${people[2].name}`,
    ).click();
    await button(captain.getByRole("dialog"), "Check current state").waitFor();
    assert.equal(
      await button(captain.getByRole("dialog"), "Cancel").count(),
      0,
    );
    await audit(captain, "unknown-invitation");
    await button(captain.getByRole("dialog"), "Check current state").click();
    await captain.getByRole("dialog").waitFor({ state: "hidden" });
    await state(captain, people[2].name, "invited");
    assert.equal(invitationPosts, 1);
    assert.ok(
      await captain
        .locator(":focus")
        .evaluate((element) => element.classList.contains("cb-team-result")),
    );
    captain.off("request", countInvite);
    record(
      "Committed invitation with lost response is resolved by GET without a second POST or misleading Cancel; result receives focus",
    );
    await teams(third);
    await action(third, "Accept team invitation");
    await captain.reload();
    await action(captain, "Remove member", row(captain, people[2].name));
    await state(captain, people[2].name, "removed");
    await third.reload();
    await state(third, "You", "removed");
    assert.equal(await row(third, people[1].name).count(), 0);
    await invite(captain, people[2]);
    await third.reload();
    await action(third, "Accept team invitation");
    await withFixture((client) =>
      client.query(
        "UPDATE campus.affiliations SET student_valid_until=now()-interval '1 day' WHERE user_id=$1",
        [people[2].id],
      ),
    );
    await third.reload();
    await action(third, "Leave team");
    await state(third, "You", "left");
    record(
      "Remove and re-invite accepted member; expired student eligibility still permits leaving",
    );

    const taskUrl = await publish(publisher, `Team snapshot bounty ${run}`);
    const proposal = `Team snapshot proposal ${run}`;
    const proposalCard = (page) =>
      page
        .locator("article")
        .filter({ has: page.getByText(proposal, { exact: true }) });
    await captain.goto(taskUrl);
    await captain.getByLabel("Apply as", { exact: true }).selectOption(teamId);
    await captain.getByLabel("Your proposal").fill(proposal);
    await button(captain, "Send application").click();
    await proposalCard(captain).waitFor();
    await member.goto(taskUrl);
    await button(proposalCard(member), "Agree to this proposal").click();
    await proposalCard(member)
      .getByText("2 of 2 participants have agreed to this proposal.", {
        exact: true,
      })
      .waitFor();
    await publisher.goto(taskUrl);
    await button(proposalCard(publisher), "Invite this applicant").click();
    await proposalCard(publisher)
      .getByText("invited", { exact: true })
      .waitFor();
    await captain.reload();
    await button(proposalCard(captain), "Review invitation").click();
    await button(proposalCard(captain), "Accept invitation").click();
    await captain.getByText("Waiting for funding", { exact: true }).waitFor();
    await captain
      .getByText(
        "Submissions and reviews require confirmed funding, an active account, and current campus email verification. Leaving a team does not remove you from this agreement.",
        { exact: true },
      )
      .waitFor();
    const agreementUrl = captain.url(),
      agreementId = new URL(agreementUrl).searchParams.get("id");
    const before = await json(captain, `agreements/${agreementId}`);
    assert.deepEqual(
      before.members.map((value) => value.user_id).sort(),
      [people[0].id, people[1].id].sort(),
    );
    assert.equal(before.captain_id, people[0].id);
    record(
      "Real UI team application, individual consent, publisher invitation and agreement creation preserve accepted roster",
    );

    await teams(captain);
    await action(captain, "Transfer captaincy", row(captain, people[1].name));
    assert.equal(await button(teamCard(captain), "Check teammate").count(), 0);
    await action(captain, "Leave team");
    await state(captain, "You", "left");
    await teams(member);
    await action(member, "Archive team");
    await teamCard(member).getByText("archived", { exact: true }).waitFor();
    assert.equal(await button(teamCard(member), "Check teammate").count(), 0);
    await audit(member, "archived-team");
    const after = await json(captain, `agreements/${agreementId}`);
    assert.deepEqual(after.members, before.members);
    assert.equal(after.captain_id, before.captain_id);
    await captain.goto(agreementUrl);
    await captain
      .getByText("2 signed collaborators (publisher not included) · 1 milestone", { exact: true })
      .waitFor();
    await captain.goto(taskUrl);
    await proposalCard(captain)
      .getByText("Participant consent", { exact: true })
      .click();
    await proposalCard(captain)
      .getByText(`${people[1].name} — Agreed`, { exact: false })
      .waitFor();
    record(
      "Transfer captaincy, former captain leaves, last member archives; old application and agreement remain accessible with unchanged roster and captain",
    );
    await teams(member);
    await audit(member, "team-history");
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(evidence, "results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          pageErrors: errors,
          scope:
            "Disposable local fixture; real browser and database; synthetic accounts; no live payment or external mail",
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
        { passed: false, error: error.stack, checks, pageErrors: errors },
        null,
        2,
      ),
    );
    for (let index = 0; index < pages.length; index++)
      await pages[index]
        .screenshot({
          path: path.join(evidence, `failure-${index}.png`),
          fullPage: true,
        })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})();
