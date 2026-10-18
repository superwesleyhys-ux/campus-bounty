// Explicit local disposable-target helper. No CLI side effects or preview option.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const migrationName = "017_agreement_amendments.sql";
export const sha256 = (v) => createHash("sha256").update(v).digest("hex");
export const expectedPrior = Object.entries(
  JSON.parse(
    await readFile(
      new URL("./agreement-amendment-prior.json", import.meta.url),
      "utf8",
    ),
  ),
)
  .map(([file, checksum]) => ({ name: path.basename(file), checksum }))
  .sort((a, b) => a.name.localeCompare(b.name));
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
export async function oldInventory(c) {
  const rows = (
    await c.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='campus' AND table_name<>'schema_migrations' ORDER BY table_name,ordinal_position",
    )
  ).rows;
  const result = {};
  for (const r of rows) (result[r.table_name] ??= []).push(r.column_name);
  return result;
}
export async function preservation(c, inventory) {
  const result = {};
  for (const [name, columns] of Object.entries(inventory)) {
    const rows = (
      await c.query(
        `SELECT row_to_json(x)::text AS row FROM (SELECT ${columns.map(quote).join(",")} FROM campus.${quote(name)}) x ORDER BY row_to_json(x)::text`,
      )
    ).rows.map((r) => r.row);
    result[name] = { rows: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  return result;
}
function docker(args, input) {
  const r = spawnSync(
    "/usr/local/bin/docker",
    ["exec", ...(input ? ["-i"] : []), "campus-bounty-backend-db", ...args],
    { input, maxBuffer: 128 * 1024 * 1024, timeout: 60000 },
  );
  if (r.status !== 0)
    throw new Error(
      "Isolated backup/restore command failed: " +
        String(r.stderr).slice(0, 4000),
    );
  return r.stdout;
}
function assertTarget(c, name) {
  assert.match(name, /^campus_r13_[a-f0-9]{32}$/);
  assert.equal(c.connectionParameters.host, "127.0.0.1");
  assert.equal(Number(c.connectionParameters.port), 5443);
  assert.equal(c.connectionParameters.user, "campus_migrator");
  assert.equal(c.connectionParameters.database, name);
}
export async function upgradeAgreementAmendments(
  c,
  {
    expectedDatabase,
    expectedMigrationSha,
    backupDirectory,
    restoreClient,
    restoreDatabase,
    ownedDatabases,
  },
) {
  assertTarget(c, expectedDatabase);
  assertTarget(restoreClient, restoreDatabase);
  assert.notEqual(expectedDatabase, restoreDatabase);
  assert.ok(
    ownedDatabases instanceof Set &&
      ownedDatabases.has(expectedDatabase) &&
      ownedDatabases.has(restoreDatabase),
    "Both exact targets must be owned by this run",
  );
  assert.equal(
    (await c.query("SELECT current_database() AS db")).rows[0].db,
    expectedDatabase,
  );
  assert.equal(
    (await restoreClient.query("SELECT current_database() AS db")).rows[0].db,
    restoreDatabase,
  );
  const sql = await readFile(
    new URL("../backend/db/migrations/" + migrationName, import.meta.url),
    "utf8",
  );
  assert.equal(sha256(sql), expectedMigrationSha);
  for (const prior of expectedPrior)
    assert.equal(
      sha256(
        await readFile(
          new URL("../backend/db/migrations/" + prior.name, import.meta.url),
        ),
      ),
      prior.checksum,
    );
  await c.query("SELECT pg_advisory_lock(hashtext('campus.migrations'))");
  try {
    const installed = (
      await c.query(
        "SELECT name,checksum FROM campus.schema_migrations ORDER BY name",
      )
    ).rows;
    assert.deepEqual(
      installed.filter((x) => x.name !== migrationName),
      expectedPrior,
    );
    const prior = installed.find((x) => x.name === migrationName);
    if (prior) {
      assert.equal(prior.checksum, expectedMigrationSha);
      return { applied: 0, replay: true, database: expectedDatabase };
    }
    assert.equal(installed.length, 16);
    assert.equal(
      (
        await restoreClient.query(
          "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname='campus'",
        )
      ).rows[0].count,
      0,
      "Restore target must be empty",
    );
    await c.query("BEGIN");
    try {
      await c.query(
        "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s'",
      );
      const inventory = await oldInventory(c);
      const cutoffStartedAt = new Date().toISOString();
      // A bounded table-write gate also covers pre-017 writers lacking new code.
      // On any lock/deadlock timeout the entire transaction aborts before backup.
      // After ALL locks are acquired, no legacy DML can cross snapshot/backfill.
      await c.query(
        `LOCK TABLE ${Object.keys(inventory)
          .sort()
          .map((n) => "campus." + quote(n))
          .join(",")} IN SHARE ROW EXCLUSIVE MODE`,
      );
      const gateAcquiredAt = new Date().toISOString();
      const before = await preservation(c, inventory);
      const archive = docker([
        "pg_dump",
        "-U",
        "campus_migrator",
        "-Fc",
        expectedDatabase,
      ]);
      docker(["pg_restore", "--list"], archive);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      const backupFile = path.resolve(
        backupDirectory,
        expectedDatabase + "-" + Date.now() + ".dump",
      );
      await writeFile(backupFile, archive, { mode: 0o600, flag: "wx" });
      assert.equal(sha256(await readFile(backupFile)), sha256(archive));
      docker(
        [
          "pg_restore",
          "--exit-on-error",
          "-U",
          "campus_migrator",
          "-d",
          restoreDatabase,
        ],
        archive,
      );
      assert.deepEqual(await oldInventory(restoreClient), inventory);
      assert.deepEqual(
        (
          await restoreClient.query(
            "SELECT name,checksum FROM campus.schema_migrations ORDER BY name",
          )
        ).rows,
        installed,
      );
      const restored = await preservation(restoreClient, inventory);
      assert.deepEqual(restored, before, "Exact archive restore data differs");
      await c.query(sql);
      const after = await preservation(c, inventory);
      assert.deepEqual(after, before, "Legacy data changed");
      const missing = (
        await c.query(
          `SELECT (SELECT count(*) FROM campus.agreements g WHERE NOT EXISTS(SELECT 1 FROM campus.agreement_terms_state s WHERE s.agreement_id=g.id))::int AS agreements,(SELECT count(*) FROM campus.submissions s WHERE NOT EXISTS(SELECT 1 FROM campus.submission_terms t WHERE t.submission_id=s.id))::int AS submissions`,
        )
      ).rows[0];
      assert.deepEqual(missing, { agreements: 0, submissions: 0 });
      await c.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [migrationName, expectedMigrationSha],
      );
      await c.query("COMMIT");
      return {
        applied: 1,
        database: expectedDatabase,
        restoreDatabase,
        migrationSha: expectedMigrationSha,
        gate: {
          mode: "SHARE ROW EXCLUSIVE",
          cutoffStartedAt,
          gateAcquiredAt,
          releasedAt: new Date().toISOString(),
          tables: Object.keys(inventory).sort(),
          lockTimeoutMs: 3000,
          scope: "all legacy DML; AccessShare backup reads permitted",
        },
        backup: {
          file: backupFile,
          bytes: archive.length,
          sha256: sha256(archive),
          exactArchiveRestored: true,
        },
        inventory,
        before,
        restored,
        after,
        preserved: true,
        missing,
      };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('campus.migrations'))");
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  throw new Error(
    "Import upgradeAgreementAmendments with explicit owned R13 targets, reviewed SHA and restore connection.",
  );
