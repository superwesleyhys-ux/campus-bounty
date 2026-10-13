import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function migrate(client) {
  await client.query("SELECT pg_advisory_lock(hashtext('campus.migrations'))");
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS campus");
    await client.query(
      "CREATE TABLE IF NOT EXISTS campus.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    let count = 0;
    const dir = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const old = (
        await client.query(
          "SELECT checksum FROM campus.schema_migrations WHERE name=$1",
          [name],
        )
      ).rows[0];
      if (old) {
        if (old.checksum !== checksum)
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        count++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return count;
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('campus.migrations'))",
    );
  }
}
