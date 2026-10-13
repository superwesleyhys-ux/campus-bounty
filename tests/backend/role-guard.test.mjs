import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";

const f = await fixture();
const store = createStore(f.urls);
test.after(async () => {
  await store.close();
  await f.close();
});

// Catalog changes remain uncommitted and are visible only to this connection.
// Run the real guard SQL on it as the runtime identity, then roll everything
// back. The shared local cluster's runtime roles never gain committed powers.
async function withRoleDrift(role, setup, check, { session = true } = {}) {
  const pool = store[role];
  const originalQuery = pool.query;
  await f.owner.query("BEGIN");
  try {
    if (setup) await f.owner.query(setup);
    await f.owner.query(
      session
        ? `SET LOCAL SESSION AUTHORIZATION campus_${role}`
        : `SET LOCAL ROLE campus_${role}`,
    );
    pool.query = (...args) => f.owner.query(...args);
    await check();
  } finally {
    pool.query = originalQuery;
    await f.owner.query("ROLLBACK");
  }
}

test("restricted runtime logins pass the real PostgreSQL startup guard", async () => {
  await store.verifyRoles();
  await withRoleDrift("app", null, () => store.verifyRoles());
});

for (const role of ["app", "auth", "worker"]) {
  for (const attribute of ["CREATEROLE", "CREATEDB", "REPLICATION"]) {
    test(`startup rejects ${role} with ${attribute}`, async () => {
      await withRoleDrift(role, `ALTER ROLE campus_${role} ${attribute}`, () =>
        assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
      );
    });
  }
  test(`startup rejects ${role} membership even without automatic inheritance`, async () => {
    await withRoleDrift(
      role,
      `GRANT pg_read_all_data TO campus_${role} WITH INHERIT FALSE, SET TRUE`,
      () => assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
    );
  });
}

test("startup rejects ownership of an RLS table without schema ownership", async () => {
  await withRoleDrift(
    "app",
    "ALTER TABLE campus.tasks OWNER TO campus_app",
    async () => {
      const { rows } = await f.owner.query(
        "SELECT relowner=current_user::regrole AS owned FROM pg_class WHERE oid='campus.tasks'::regclass",
      );
      assert.equal(rows[0].owned, true);
      await assert.rejects(store.verifyRoles(), /Unsafe backend database role/);
    },
  );
});

test("startup rejects ownership of a security-definer function", async () => {
  await withRoleDrift(
    "app",
    "ALTER FUNCTION campus.is_member() OWNER TO campus_app",
    () => assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
  );
});

test("startup rejects a privileged session masked by SET ROLE", async () => {
  await withRoleDrift(
    "app",
    null,
    () => assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
    { session: false },
  );
});

test("startup rejects runtime ownership of the test database", async () => {
  const database = (await f.owner.query("SELECT current_database() AS name"))
    .rows[0].name;
  await withRoleDrift(
    "app",
    `ALTER DATABASE ${pg.escapeIdentifier(database)} OWNER TO campus_app`,
    () => assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
  );
});

test("startup requires the migrated campus schema", async () => {
  await withRoleDrift(
    "app",
    "ALTER SCHEMA campus RENAME TO campus_not_ready",
    () => assert.rejects(store.verifyRoles(), /Unsafe backend database role/),
  );
});

test("all catalog drift rolls back and real runtime logins stay restricted", async () => {
  await store.verifyRoles();
  const { rows } = await f.owner.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('campus_app','campus_auth','campus_worker') AND (rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=pg_roles.oid))",
  );
  assert.equal(rows.length, 0);
});
