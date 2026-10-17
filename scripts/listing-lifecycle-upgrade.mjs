// Reviewed single-migration helper. Import explicitly; there is no automatic CLI/target discovery.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const migrationName = "015_listing_lifecycle.sql";
const migrationPath = new URL(
  "../backend/db/migrations/" + migrationName,
  import.meta.url,
);
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
const priorManifest = JSON.parse(
  await readFile(
    new URL("./listing-lifecycle-prior.json", import.meta.url),
    "utf8",
  ),
);
export const expectedPrior = Object.entries(priorManifest)
  .map(([file, checksum]) => ({ name: path.basename(file), checksum }))
  .sort((a, b) => a.name.localeCompare(b.name));
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
function dump(database) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "campus-bounty-backend-db",
      "pg_dump",
      "-U",
      "campus_migrator",
      "-Fc",
      database,
    ],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  if (r.status !== 0)
    throw new Error("Local database backup failed; no migration applied.");
  const check = spawnSync(
    "docker",
    ["exec", "-i", "campus-bounty-backend-db", "pg_restore", "--list"],
    { input: r.stdout, maxBuffer: 128 * 1024 * 1024 },
  );
  if (check.status !== 0 || !check.stdout.includes(Buffer.from("campus")))
    throw new Error("Backup archive verification failed.");
  return r.stdout;
}
export async function upgradeListingLifecycle(
  c,
  {
    expectedDatabase,
    expectedMigrationSha,
    backupDirectory,
    allowReviewedPreview = false,
  },
) {
  assert.equal(
    c.connectionParameters.host,
    "127.0.0.1",
    "Only the local reviewed host is allowed",
  );
  assert.equal(
    Number(c.connectionParameters.port),
    5443,
    "Only the reviewed local database port is allowed",
  );
  assert.equal(c.connectionParameters.user, "campus_migrator");
  assert.ok(
    /^campus_r12_[a-f0-9]{32}$/.test(expectedDatabase) ||
      (allowReviewedPreview === true &&
        expectedDatabase === "campus_test_425fb12890d645e8a87c9fc441d3db24"),
    "Target must be an explicit R12 isolated DB or the explicitly released preview",
  );
  assert.equal(c.database ?? c.connectionParameters.database, expectedDatabase);
  assert.equal(
    (await c.query("SELECT current_database() AS db")).rows[0].db,
    expectedDatabase,
  );
  assert.match(expectedMigrationSha, /^[a-f0-9]{64}$/);
  const sql = await readFile(migrationPath, "utf8");
  assert.equal(sha256(sql), expectedMigrationSha, "Reviewed migration changed");
  for (const prior of expectedPrior) {
    const source = await readFile(
      new URL("../backend/db/migrations/" + prior.name, import.meta.url),
    );
    assert.equal(
      sha256(source),
      prior.checksum,
      "Old migration source changed",
    );
  }
  await c.query("SELECT pg_advisory_lock(hashtext('campus.migrations'))");
  try {
    const applied = (
      await c.query(
        "SELECT name,checksum FROM campus.schema_migrations ORDER BY name",
      )
    ).rows;
    const old = applied.find((r) => r.name === migrationName);
    assert.deepEqual(
      applied.filter((r) => r.name !== migrationName),
      expectedPrior,
      "Old installed migration checksums differ",
    );
    if (old) {
      assert.equal(old.checksum, expectedMigrationSha);
      return { applied: 0, replay: true, database: expectedDatabase };
    }
    assert.equal(applied.length, 14);
    await c.query("BEGIN");
    try {
      const inventory = await oldInventory(c);
      for (const name of Object.keys(inventory))
        await c.query(
          `LOCK TABLE campus.${quote(name)} IN SHARE ROW EXCLUSIVE MODE`,
        );
      const before = await preservation(c, inventory);
      const backup = dump(expectedDatabase);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      const backupFile = path.resolve(
        backupDirectory,
        expectedDatabase + "-" + Date.now() + ".dump",
      );
      await writeFile(backupFile, backup, { mode: 0o600, flag: "wx" });
      assert.equal(sha256(await readFile(backupFile)), sha256(backup));
      await c.query(sql);
      const after = await preservation(c, inventory);
      assert.deepEqual(
        after,
        before,
        "Existing business columns changed; upgrade rolled back",
      );
      await c.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [migrationName, expectedMigrationSha],
      );
      const report = {
        applied: 1,
        database: expectedDatabase,
        migrationSha: expectedMigrationSha,
        backup: {
          file: backupFile,
          bytes: backup.length,
          sha256: sha256(backup),
          archiveVerified: true,
        },
        inventory,
        before,
        after,
        preserved: true,
      };
      await c.query("COMMIT");
      return report;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('campus.migrations'))");
  }
}
// Deliberately not executable as an implicit command: root must supply exact reviewed parameters.
if (process.argv[1] === fileURLToPath(import.meta.url))
  throw new Error(
    "Import upgradeListingLifecycle with an explicitly reviewed target, SHA and backup directory.",
  );
