// In-place upgrade check for the existing local disposable browser fixture only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { withFixture } = require("./team-browser-support.cjs");
const digest = (value) => createHash("sha256").update(value).digest("hex");

(async () => {
  const expected = process.env.EXPECTED_TEAM_CONTEXT_SHA;
  assert.match(expected || "", /^[a-f0-9]{64}$/, "Require the independently frozen migration hash");
  const migration = "009_team_context.sql";
  assert.equal(digest(fs.readFileSync(`backend/db/migrations/${migration}`)), expected);
  const { migrate } = await import("../backend/db/migrate.mjs");
  const result = await withFixture(async (client) => {
    assert.equal((await client.query("SELECT count(*)::int AS n FROM campus.schema_migrations WHERE name=$1", [migration])).rows[0].n, 0, "Upgrade already applied; do not claim another before/after run");
    async function snapshot() {
      const values = {};
      for (const table of ["teams", "team_members", "team_membership_events", "applications", "application_members", "agreements", "agreement_members", "milestones", "submissions"]) {
        // Table names are fixed locally, never user inputs. Row serialization is sorted deterministically.
        const rows = (await client.query(`SELECT row_to_json(t)::text AS row FROM campus.${table} t ORDER BY row_to_json(t)::text`)).rows;
        values[table] = { count: rows.length, sha256: digest(JSON.stringify(rows)) };
      }
      return values;
    }
    const before = await snapshot();
    const pendingBefore = (await client.query("SELECT count(*)::int AS n FROM campus.team_members WHERE state='invited'")).rows[0].n;
    const applied = await migrate(client);
    const after = await snapshot();
    assert.equal(applied, 1);
    assert.deepEqual(after, before, "Existing relationships, terms, and submissions must remain byte-identical");
    const row = (await client.query("SELECT checksum FROM campus.schema_migrations WHERE name=$1", [migration])).rows[0];
    assert.equal(row.checksum, expected);
    const contexts = (await client.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE purpose='' AND activities='' AND time_commitment='' AND project_context='')::int AS blank FROM campus.team_contexts")).rows[0];
    assert.equal(contexts.total, before.teams.count);
    assert.equal(contexts.blank, before.teams.count);
    return { migration, sha256: expected, applied, pendingInvitationsPreserved: pendingBefore, before, after, newContextRows: contexts, scope: "Existing loopback disposable fixture only; no production migration or real service acceptance" };
  });
  const folder = path.resolve("docs/evidence/interaction-round5");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "preview-upgrade.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
