// Upgrade only the existing disposable loopback fixture, preserving old records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { withFixture } = require("./team-browser-support.cjs");
const digest = (value) => createHash("sha256").update(value).digest("hex");

(async () => {
  const expected = process.env.EXPECTED_FULFILLMENT_SHA;
  assert.match(expected || "", /^[a-f0-9]{64}$/);
  const migration = "010_milestone_revision_workflow.sql";
  assert.equal(
    digest(fs.readFileSync(`backend/db/migrations/${migration}`)),
    expected,
  );
  const folder = path.resolve("docs/evidence/interaction-round6");
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
    const additions = (
      await client.query(
        "SELECT count(*)::int AS total, count(*) FILTER(WHERE revision=1)::int AS initial_revisions FROM campus.milestones",
      )
    ).rows[0];
    assert.equal(additions.total, before.milestones.count);
    assert.equal(additions.initial_revisions, additions.total);
    const dangling = (
      await client.query(
        "SELECT count(*)::int AS n FROM campus.milestones m WHERE (m.latest_submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campus.submissions s WHERE s.id=m.latest_submission_id AND s.milestone_id=m.id AND s.version=m.version)) OR (m.accepted_submission_id IS NOT NULL AND (m.state<>'accepted' OR m.accepted_submission_id IS DISTINCT FROM m.latest_submission_id))",
      )
    ).rows[0].n;
    assert.equal(dangling, 0);
    return {
      migration,
      sha256: expected,
      applied,
      comparedColumns: columns,
      before,
      after,
      additions,
      danglingSubmissionReferences: dangling,
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
