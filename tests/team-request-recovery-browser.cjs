// Reproduces and guards browser-refresh recovery using disposable synthetic accounts only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
  `browser-request-recovery-${run}`,
);
fs.mkdirSync(evidence, { recursive: true });
const checks = [],
  requests = [],
  errors = [];
const record = (check, data = {}) => {
  checks.push({ check, ...data });
  console.log(`PASS: ${check}`);
};
const createPanel = (page) =>
  page.locator(".cb-panel").filter({
    has: page.getByRole("heading", { name: "Create a team", exact: true }),
  });
async function submit(page, name, lost = false) {
  const interrupt = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort();
  };
  if (lost) await page.route("**/api/v1/teams", interrupt);
  await page.getByLabel("Team name", { exact: true }).fill(name);
  await fillTeamBackground(createPanel(page));
  const response = lost
    ? null
    : page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && r.url().endsWith("/api/v1/teams"),
      );
  await button(page, "Create team").click();
  if (lost) {
    await button(page, "Retry same creation").waitFor();
    await page.unroute("**/api/v1/teams", interrupt);
    return null;
  }
  const value = await (await response).json();
  await createPanel(page).locator(".cb-success").waitFor();
  return value;
}
async function count(name) {
  return withFixture(async (client) =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM campus.teams WHERE name=$1",
          [name],
        )
      ).rows[0].n,
    ),
  );
}
async function stored(page) {
  return page.evaluate(() =>
    Object.entries(sessionStorage)
      .filter(([key]) => key.startsWith("campus:pending:"))
      .map(([key, value]) => ({ key, value })),
  );
}
async function post(page, route, body) {
  const result = await page.evaluate(
    async ({ route, body, key }) => {
      const r = await fetch(`/api/v1/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() };
    },
    { route, body, key: randomUUID() },
  );
  assert.ok(result.status < 300, JSON.stringify(result));
  return result.data;
}
async function findTeam(page, name) {
  return page.evaluate(
    async (name) =>
      (await (await fetch("/api/v1/teams", { cache: "no-store" })).json()).find(
        (team) => team.name === name,
      ),
    name,
  );
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  let page;
  try {
    const people = await seedPeople(["Recovery Captain", "Recovery Member"]);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/v1/teams")
      )
        requests.push({
          name: request.postDataJSON()?.name,
          key: request.headers()["idempotency-key"],
        });
    });
    await login(page, people[0]);
    await page.goto(`${origin}/?view=teams`);
    const sameName = `Refresh recovery ${run}`;
    await submit(page, sameName, true);
    await page.screenshot({
      path: path.join(evidence, "creation-response-lost.png"),
      fullPage: true,
    });
    assert.equal(await count(sameName), 1, "First POST really committed");
    await page.reload();
    await submit(page, sameName);
    assert.equal(
      await count(sameName),
      1,
      "Refresh and retry must not create a second team",
    );
    const pair = requests.filter((request) => request.name === sameName);
    assert.equal(pair.length, 2);
    assert.equal(
      pair[0].key,
      pair[1].key,
      "Retry after reload retains original key",
    );
    assert.equal(
      (await stored(page)).length,
      0,
      "Success clears saved pending key",
    );
    record(
      "POST commits, response is lost, browser reloads, same name retries same key and one database team remains",
    );
    await submit(page, sameName);
    assert.equal(
      await count(sameName),
      2,
      "A resolved creation allows a new same-name team",
    );
    assert.notEqual(requests.at(-1).key, pair[0].key);
    record(
      "Successful resolution clears the key so an intentional later same-name creation creates another team",
    );

    const archivedName = `Archived replay ${run}`;
    await submit(page, archivedName, true);
    const pendingBefore = await stored(page);
    assert.equal(pendingBefore.length, 1);
    assert.ok(
      pendingBefore[0].key.startsWith(
        `campus:pending:${people[0].id}:POST:teams:`,
      ),
      "Key is account-scoped",
    );
    assert.ok(
      !JSON.stringify(pendingBefore).includes(archivedName),
      "Storage contains no raw request name",
    );
    assert.match(
      pendingBefore[0].key.slice(pendingBefore[0].key.lastIndexOf(":") + 1),
      /^[a-f0-9]{64}$/,
      "Body identity is a digest",
    );
    const archived = await findTeam(page, archivedName);
    await post(page, `teams/${archived.id}/archive`, {
      expectedRevision: archived.revision,
    });
    await button(page, "Retry same creation").click();
    await createPanel(page)
      .getByText(
        `${archivedName} is archived. Existing proposals and agreements are unchanged.`,
        { exact: true },
      )
      .waitFor();
    assert.equal(await count(archivedName), 1);
    assert.equal((await stored(page)).length, 0);
    record(
      "Archived creation replay displays current archived state; only scoped digest and key were stored, then cleared",
    );

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await login(memberPage, people[1]);
    const transferredName = `Transferred replay ${run}`;
    await submit(page, transferredName, true);
    let transferred = await findTeam(page, transferredName);
    transferred = await post(page, `teams/${transferred.id}/invitations`, {
      userId: people[1].id,
      expectedRevision: transferred.revision,
    });
    transferred = await post(memberPage, `teams/${transferred.id}/membership`, {
      expectedRevision: transferred.revision,
    });
    transferred = await post(page, `teams/${transferred.id}/captain`, {
      userId: people[1].id,
      expectedRevision: transferred.revision,
    });
    await button(page, "Retry same creation").click();
    await createPanel(page)
      .getByText(
        `${transferredName} is active. You are a team member; the current captain manages invitations.`,
        { exact: true },
      )
      .waitFor();
    assert.equal(await count(transferredName), 1);
    record(
      "Transferred creation replay displays current member role without telling the former captain to invite",
    );

    const inviteName = `Readback cleanup ${run}`;
    const inviteTeam = await submit(page, inviteName);
    const inviteCard = page.locator(".cb-team-card").filter({
      has: page.getByRole("heading", { name: inviteName, exact: true }),
    });
    await inviteCard.getByLabel("Teammate’s member code").fill(people[1].id);
    await button(inviteCard, "Check teammate").click();
    await button(inviteCard, `Invite ${people[1].name}`).click();
    await page.route(
      `**/api/v1/teams/${inviteTeam.id}/invitations`,
      async (route) => {
        await route.fetch();
        await route.abort();
      },
      { times: 1 },
    );
    await button(
      page.getByRole("dialog"),
      `Confirm: Invite ${people[1].name}`,
    ).click();
    await button(page.getByRole("dialog"), "Check current state").waitFor();
    assert.equal((await stored(page)).length, 1);
    await button(page.getByRole("dialog"), "Check current state").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      (await stored(page)).length,
      0,
      "GET-confirmed completion clears the saved request key",
    );
    record(
      "Authoritative GET confirms an invitation after lost response and clears its saved key",
    );

    await button(inviteCard, "Revoke invitation").click();
    const currentInviteTeam = await findTeam(page, inviteName);
    await post(memberPage, `teams/${inviteTeam.id}/membership`, {
      expectedRevision: currentInviteTeam.revision,
    });
    const conflict = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/members/${people[1].id}/revoke`) &&
        response.request().method() === "POST",
    );
    await button(
      page.getByRole("dialog"),
      "Confirm: Revoke invitation",
    ).click();
    assert.equal((await conflict).status(), 409);
    await page.getByRole("dialog").locator(".cb-error[role='alert']").waitFor();
    assert.equal(
      (await stored(page)).length,
      0,
      "Definitive 4xx response clears the saved request key",
    );
    await button(page.getByRole("dialog"), "Close and review team").click();
    record(
      "A real concurrent membership change returns 409 and clears the failed request key",
    );

    // Simulate browser storage being unavailable, while preserving in-memory retries.
    await page.evaluate(() => {
      for (const name of ["getItem", "setItem", "removeItem"]) {
        const original = Storage.prototype[name];
        Storage.prototype[name] = function (key, ...args) {
          if (String(key).startsWith("campus:pending:"))
            throw new DOMException("Storage unavailable", "SecurityError");
          return original.call(this, key, ...args);
        };
      }
    });
    const memoryName = `Memory recovery ${run}`;
    await submit(page, memoryName, true);
    await button(page, "Retry same creation").click();
    await createPanel(page).locator(".cb-success").waitFor();
    const memoryRequests = requests.filter(
      (request) => request.name === memoryName,
    );
    assert.equal(memoryRequests.length, 2);
    assert.equal(memoryRequests[0].key, memoryRequests[1].key);
    assert.equal(await count(memoryName), 1);
    record(
      "Storage unavailable still preserves the exact in-memory request key for retries",
    );
    await page.screenshot({
      path: path.join(evidence, "recovery-complete.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(evidence, "results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          pageErrors: errors,
          requestCount: requests.length,
          scope:
            "Disposable loopback fixture; synthetic accounts; no raw request body or credentials stored by the UI",
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
        {
          passed: false,
          error: error.stack,
          checks,
          observedCreationKeys: requests,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
    if (page)
      await page
        .screenshot({
          path: path.join(evidence, "failure.png"),
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
