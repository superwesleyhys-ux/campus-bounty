import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
const config = localConfig();
const database = "campus_schema_test_" + process.pid;
const admin = new pg.Client({
  connectionString: connectionString(config, "migrator"),
});
await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
const owner = new pg.Client({
  connectionString: connectionString(config, "migrator", database),
});
await owner.connect();
await migrate(owner);
const app = new pg.Client({
  connectionString: connectionString(config, "app", database),
});
await app.connect();
test.after(async () => {
  await app.end();
  await owner.end();
  await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
});
test("migrations create normalized business tables, are repeatable and RLS fails closed", async () => {
  assert.equal(
    (await owner.query("SELECT to_regclass('campus.tasks') AS name")).rows[0]
      .name,
    "campus.tasks",
  );
  assert.equal(await migrate(owner), 0);
  const a = randomUUID(),
    b = randomUUID();
  await owner.query(
    "INSERT INTO campus.users(id,display_name) VALUES($1,$2),($3,$4)",
    [a, "Alice", b, "Bob"],
  );
  await owner.query(
    "INSERT INTO campus.tasks(id,owner_id,title,category) VALUES($1,$2,'Published test task','Research')",
    [randomUUID(), a],
  );
  assert.equal((await app.query("SELECT id FROM campus.tasks")).rowCount, 0);
  await assert.rejects(app.query("SELECT * FROM campus.sessions"), {
    code: "42501",
  });
  await assert.rejects(app.query("CREATE TABLE campus.bad(id int)"), {
    code: "42501",
  });
  await app.query("BEGIN");
  await app.query("SELECT set_config('campus.actor_id',$1,true)", [a]);
  assert.equal((await app.query("SELECT id FROM campus.tasks")).rowCount, 1);
  await app.query("ROLLBACK");
  assert.equal((await app.query("SELECT id FROM campus.tasks")).rowCount, 0);
  const attrs = (
    await app.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
  ).rows[0];
  assert.deepEqual(attrs, { rolsuper: false, rolbypassrls: false });
});
