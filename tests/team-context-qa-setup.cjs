// Synthetic local UI-test setup. Private sessions remain in ignored .data only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { seedPeople, login, withFixture } = require("./team-browser-support.cjs");

(async () => {
  const folder = path.resolve(".data/qa/round5");
  assert.ok(!fs.existsSync(path.join(folder, "people.json")), "Do not replace existing QA sessions");
  await withFixture(async (client) => {
    assert.equal((await client.query("SELECT count(*)::int AS n FROM campus.schema_migrations WHERE name='009_team_context.sql'")).rows[0].n, 1);
  });
  const people = await seedPeople(["Nina Shah", "Jamie Lin", "Casey Ortiz", "Avery Jones", "Morgan Lee"]);
  const { localConfig, connectionString } = await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const fixture = JSON.parse(fs.readFileSync(".data/backend/interaction/fixture.json"));
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const urls = Object.fromEntries(["app", "auth", "worker"].map((role) => [role, connectionString(localConfig(), role, fixture.database)]));
  const store = createStore(urls), market = createMarket(store), teams = [];
  try {
    for (const [captain, name, context] of [
      [people[3], "Library access notes", {
        purpose: "Compare public library signs and share practical ideas for making campus directions easier to understand.",
        activities: "Meet Tuesdays at 12:30 p.m. outside the main library for a 30-minute walk, then share a short note before Friday. Runs for four weeks.",
        timeCommitment: "About 90 minutes per week including the walk. No weekend availability expected.",
        projectContext: "An informal peer study group. There is no paid project or signed bounty agreement attached to joining.",
      }],
      [people[4], "Weekend accessibility mapping", {
        purpose: "Build a detailed map of accessible campus routes with weekly field observations.",
        activities: "Saturday field walks from 9 a.m. to noon plus a Wednesday evening map review. Runs through the end of the semester.",
        timeCommitment: "At least six hours each week, including the Saturday walk and independent map updates.",
        projectContext: "This is an exploratory student project. Any future paid task would need a separate proposal and agreement.",
      }],
    ]) {
      let team = await market.createTeam(captain.id, { name, context }, randomUUID());
      team = await market.inviteMember(captain.id, team.id, { userId: people[0].id, expectedRevision: team.revision }, randomUUID());
      teams.push({ id: team.id, name });
    }
  } finally { await store.close(); }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, "people.json"), JSON.stringify({ people, teams }, null, 2), { flag: "wx", mode: 0o600 });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [index, file] of [[0, "persona.state.json"], [1, "dogfood-captain.state.json"], [2, "dogfood-member.state.json"]]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await login(page, people[index]);
        await context.storageState({ path: path.join(folder, file) });
        fs.chmodSync(path.join(folder, file), 0o600);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log("Prepared three isolated local UI sessions and two synthetic invitations. No external email or payment.");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
