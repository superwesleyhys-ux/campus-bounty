import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { createStore, idempotent } from "../../backend/db/store.mjs";
const f = await fixture();
let store;
test.after(async () => {
  await store?.close();
  await f.close();
});
test("actor context, atomic rollback and concurrent request idempotency use real transactions", async () => {
  store = createStore(f.urls);
  await store.verifyRoles();
  const a = await f.user("Alice");
  const command = () =>
    store.as(a, (c) =>
      idempotent(c, a, "test", "request-key-1", { a: 1 }, async () => {
        const row = (
          await c.query(
            "INSERT INTO campus.tasks(owner_id,title,category) VALUES($1,'One task','Research') RETURNING id",
            [a],
          )
        ).rows[0];
        return row;
      }),
    );
  const values = await Promise.all([command(), command(), command()]);
  assert.equal(new Set(values.map((v) => v.id)).size, 1);
  await assert.rejects(
    store.as(a, (c) =>
      idempotent(c, a, "test", "request-key-1", { a: 2 }, () => {}),
    ),
    (e) => e.code === "idempotency_conflict",
  );
  await assert.rejects(
    store.as(a, async (c) => {
      await c.query(
        "INSERT INTO campus.tasks(owner_id,title,category) VALUES($1,'Rollback','Research')",
        [a],
      );
      throw Error("rollback");
    }),
    /rollback/,
  );
  assert.equal(
    (await store.app.query("SELECT * FROM campus.tasks")).rowCount,
    0,
  );
  assert.equal((await f.owner.query("SELECT * FROM campus.tasks")).rowCount, 1);
});
