// Upgrade only the existing disposable loopback fixture, preserving old records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { withFixture } = require("./team-browser-support.cjs");
const digest = (value) => createHash("sha256").update(value).digest("hex");

(async () => {
  const expected = process.env.EXPECTED_NOTIFICATION_SHA;
  assert.match(expected || "", /^[a-f0-9]{64}$/);
  const migration = process.env.NOTIFICATION_MIGRATION;
  assert.match(migration || "", /^011_[a-z0-9_]+\.sql$/);
  assert.equal(
    digest(fs.readFileSync(`backend/db/migrations/${migration}`)),
    expected,
  );
  const folder = path.resolve("docs/evidence/interaction-round7");
  fs.mkdirSync(folder, { recursive: true });
  const output = path.join(folder, "preview-upgrade.json");
  assert.ok(
    !fs.existsSync(output),
    "Do not overwrite an earlier upgrade receipt",
  );
  const { migrate } = await import("../backend/db/migrate.mjs");
  const result = await withFixture(async (client) => {
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM campus.schema_migrations WHERE name=$1",
          [migration],
        )
      ).rows[0].n,
      0,
      "Migration already applied",
    );
    const tables = [
      "teams",
      "team_members",
      "team_contexts",
      "team_membership_events",
      "applications",
      "application_members",
      "agreements",
      "agreement_members",
      "milestones",
      "submissions",
      "milestone_reviews",
      "team_context_events",
      "tasks",
      "task_milestones",
      "products",
      "quotes",
      "orders",
      "messages",
      "eligibility_requests",
      "users",
      "affiliations",
    ];
    const columns = {};
    for (const table of tables) {
      columns[table] = (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='campus' AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows.map((r) => r.column_name);
      assert.ok(columns[table].length);
    }
    async function snapshot() {
      const values = {};
      for (const table of tables) {
        // Identifiers come only from catalog columns for these fixed local tables.
        const projection = columns[table]
          .map((name) => '"' + name.replaceAll('"', '""') + '"')
          .join(",");
        const rows = (
          await client.query(
            `SELECT row_to_json(t)::text AS row FROM (SELECT ${projection} FROM campus.${table}) t ORDER BY row_to_json(t)::text`,
          )
        ).rows;
        values[table] = {
          count: rows.length,
          sha256: digest(JSON.stringify(rows)),
        };
      }
      return values;
    }
    const before = await snapshot();
    fs.writeFileSync(
      path.join(folder, "preview-upgrade-before.json"),
      JSON.stringify(
        { migration, sha256: expected, comparedColumns: columns, before },
        null,
        2,
      ),
      { flag: "wx" },
    );
    const applied = await migrate(client);
    const after = await snapshot();
    fs.writeFileSync(
      path.join(folder, "preview-upgrade-after.json"),
      JSON.stringify({ migration, sha256: expected, applied, after }, null, 2),
      { flag: "wx" },
    );
    assert.equal(applied, 1);
    assert.deepEqual(
      after,
      before,
      "All pre-upgrade columns and records must be preserved",
    );
    assert.equal(
      (
        await client.query(
          "SELECT checksum FROM campus.schema_migrations WHERE name=$1",
          [migration],
        )
      ).rows[0].checksum,
      expected,
    );
    const notifications = (
      await client.query("SELECT count(*)::int AS n FROM campus.notifications")
    ).rows[0].n;
    assert.equal(
      notifications,
      0,
      "Do not backfill invented historical notifications",
    );
    return {
      migration,
      sha256: expected,
      applied,
      comparedColumns: columns,
      before,
      after,
      initialNotifications: notifications,
      scope:
        "In-place upgrade of an existing loopback disposable fixture; no production migration, real funding, or payment verification.",
    };
  });
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
