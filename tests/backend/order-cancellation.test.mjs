import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { migrate } from "../../backend/db/migrate.mjs";

const f = await fixture();
const store = createStore(f.urls);
const market = createMarket(store);
const seller = await f.user("Seller");
const buyer = await f.user("Buyer");
const other = await f.user("Other buyer");
const key = () => randomUUID();
const address = {
  name: "Synthetic Buyer",
  line1: "1 Test Way",
  city: "Test City",
  region: "CA",
  postalCode: "00000",
  country: "US",
};
test.after(async () => {
  await store.close();
  await f.close();
});
async function listing(stock = 5) {
  return market.publishProduct(
    seller,
    {
      title: "Cancellation fixture",
      description: "Synthetic isolated database item",
      priceCents: 1000,
      stock,
      deliveryMethods: ["pickup", "shipping"],
      shippingCents: 125,
    },
    key(),
  );
}
async function reserve(p, quantity = 1, method = "pickup") {
  const q = await market.quote(
    buyer,
    p.id,
    {
      quantity,
      deliveryMethod: method,
    },
    key(),
  );
  return market.order(
    buyer,
    {
      quoteId: q.id,
      ...(method === "shipping" ? { shippingAddress: address } : {}),
    },
    key(),
  );
}
async function stock(p) {
  return (
    await f.owner.query("SELECT stock FROM campus.products WHERE id=$1", [p.id])
  ).rows[0].stock;
}
async function expired(o) {
  await f.owner.query(
    "UPDATE campus.orders SET reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [o.id],
  );
}
async function waiting(role) {
  for (let i = 0; i < 150; i++) {
    const r = await f.owner.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'",
      [role],
    );
    if (r.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${role} did not reach the controlled lock`);
}
const businessError = (code, status) => (error) =>
  error.code === code && error.status === status;
const immutableTerms = (o) =>
  Object.fromEntries(
    [
      "id",
      "quote_id",
      "product_id",
      "buyer_id",
      "seller_id",
      "quantity",
      "total_cents",
      "delivery_method",
      "shipping_address",
      "terms",
      "reserved_until",
      "created_at",
    ].map((field) => [field, o[field]]),
  );

test("buyer cancellation preserves frozen shipping terms; same/new keys release stock only once", async () => {
  const p = await listing();
  const o = await reserve(p, 2, "shipping");
  assert.equal(await stock(p), 3);
  const cancelKey = key();
  const first = await market.cancelOrder(buyer, o.id, {}, cancelKey);
  assert.equal(first.state, "cancelled");
  assert.deepEqual(immutableTerms(first), immutableTerms(o));
  assert.deepEqual(await market.cancelOrder(buyer, o.id, {}, cancelKey), first);
  const audit = async () =>
    Number(
      (
        await f.owner.query(
          "SELECT count(*) FROM campus.audit WHERE action=$1 AND object_id=$2",
          ["order.cancel:" + o.id, o.id],
        )
      ).rows[0].count,
    );
  assert.equal(await audit(), 1);
  assert.deepEqual(await market.cancelOrder(buyer, o.id, {}, key()), first);
  assert.equal(
    await audit(),
    2,
    "new command keys retain the existing accepted-command audit pattern",
  );
  assert.equal(await stock(p), 5);
  assert.equal(await market.expireReservations(), 0);
  assert.equal(await stock(p), 5);
  const retry = await market.order(
    buyer,
    { quoteId: o.quote_id, shippingAddress: address },
    key(),
  );
  assert.equal(retry.id, o.id);
  assert.equal(
    retry.state,
    "cancelled",
    "reusing the consumed quote never reserves stock again",
  );
  assert.equal(await stock(p), 5);
});

test("cancel endpoint contract rejects unexpected fields and requires an idempotency key", async () => {
  const p = await listing();
  const o = await reserve(p);
  await assert.rejects(
    market.cancelOrder(buyer, o.id, { quantity: 2 }, key()),
    businessError("invalid_input", 422),
  );
  await assert.rejects(
    market.cancelOrder(buyer, o.id, {}, null),
    businessError("idempotency_required", 400),
  );
  assert.equal((await market.getOrder(buyer, o.id)).state, "pending_payment");
  assert.equal(await stock(p), 4);
});

test("seller and unrelated accounts cannot cancel or invoke a privileged cancellation", async () => {
  const p = await listing();
  const o = await reserve(p);
  await assert.rejects(
    market.cancelOrder(seller, o.id, {}, key()),
    businessError("not_buyer", 403),
  );
  await assert.rejects(
    market.cancelOrder(other, o.id, {}, key()),
    businessError("not_found", 404),
  );
  for (const [actor, message] of [
    [seller, "not_buyer"],
    [other, "not_found"],
  ]) {
    await assert.rejects(
      store.as(actor, (c) =>
        c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]),
      ),
      (error) => error.code === "P0001" && error.message === message,
    );
  }
  await assert.rejects(
    store.as(null, (c) =>
      c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]),
    ),
    (error) =>
      error.code === "P0001" && error.message === "membership_required",
  );
  assert.equal(await stock(p), 4);
  assert.equal((await market.getOrder(buyer, o.id)).state, "pending_payment");
});

test("paid, shipped, ready-for-pickup and completed orders cannot be cancelled", async () => {
  for (const state of ["paid", "shipped", "ready_for_pickup", "completed"]) {
    const p = await listing();
    const o = await reserve(p);
    // Payment fixtures are administrative and only affect this disposable DB.
    await f.owner.query("UPDATE campus.orders SET state=$2 WHERE id=$1", [
      o.id,
      state,
    ]);
    await assert.rejects(
      market.cancelOrder(buyer, o.id, {}, key()),
      businessError("invalid_state", 409),
    );
    await assert.rejects(
      store.as(buyer, (c) =>
        c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]),
      ),
      (error) => error.code === "P0001" && error.message === "invalid_state",
    );
    assert.equal((await market.getOrder(buyer, o.id)).state, state);
    assert.equal(await stock(p), 4);
  }
});

test("already-expired reservations return expired without restoring inventory again", async () => {
  const p = await listing();
  const o = await reserve(p, 3);
  await expired(o);
  assert.equal(await market.expireReservations(), 1);
  assert.equal(
    (await market.cancelOrder(buyer, o.id, {}, key())).state,
    "expired",
  );
  assert.equal(
    (await market.cancelOrder(buyer, o.id, {}, key())).state,
    "expired",
  );
  assert.equal(await market.expireReservations(), 0);
  assert.equal(await stock(p), 5);
});

test("twenty concurrent cancellation keys restore a reservation once", async () => {
  const p = await listing(4);
  const o = await reserve(p, 4);
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      market.cancelOrder(buyer, o.id, {}, key()),
    ),
  );
  assert.ok(results.every((r) => r.id === o.id && r.state === "cancelled"));
  assert.equal(await stock(p), 4);
  assert.equal(await market.expireReservations(), 0);
});

test("expiration wins a controlled race and queued cancellation observes the expired state", async () => {
  const p = await listing(2);
  const o = await reserve(p, 2);
  await expired(o);
  let worker, cancel;
  await f.owner.query("BEGIN");
  try {
    await f.owner.query(
      "SELECT id FROM campus.products WHERE id=$1 FOR UPDATE",
      [p.id],
    );
    worker = market.expireReservations();
    await waiting("campus_worker");
    cancel = market.cancelOrder(buyer, o.id, {}, key());
    await waiting("campus_app");
    await f.owner.query("COMMIT");
    assert.equal(await worker, 1);
    assert.equal((await cancel).state, "expired");
    assert.equal(await stock(p), 2);
    assert.equal(await market.expireReservations(), 0);
  } finally {
    await f.owner.query("ROLLBACK");
    await Promise.allSettled([worker, cancel]);
  }
});

test("cancellation owns the order lock before expiration and concurrent repurchase reserves the released unit", async () => {
  const p = await listing(1);
  const q = await market.quote(
    other,
    p.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const o = await reserve(p);
  await expired(o);
  let cancel, repurchase;
  await f.owner.query("BEGIN");
  try {
    await f.owner.query(
      "SELECT id FROM campus.products WHERE id=$1 FOR UPDATE",
      [p.id],
    );
    cancel = market.cancelOrder(buyer, o.id, {}, key());
    await waiting("campus_app");
    assert.equal(
      await market.expireReservations(),
      0,
      "worker skips the cancellation's locked order",
    );
    repurchase = market.order(other, { quoteId: q.id }, key());
    await f.owner.query("COMMIT");
    assert.equal((await cancel).state, "cancelled");
    assert.equal((await repurchase).state, "pending_payment");
    assert.equal(await stock(p), 0);
    assert.equal(await market.expireReservations(), 0);
  } finally {
    await f.owner.query("ROLLBACK");
    await Promise.allSettled([cancel, repurchase]);
  }
});

test("restricted SQL commands cannot broaden inventory writes or manufacture/restock orders", async () => {
  const p = await listing();
  const o = await reserve(p);
  for (const actor of [buyer, other]) {
    const result = await store.as(actor, (c) =>
      c.query(
        "UPDATE campus.products SET stock=stock+100 WHERE id=$1 RETURNING id",
        [p.id],
      ),
    );
    assert.equal(
      result.rowCount,
      0,
      "RLS must prohibit direct cross-seller inventory changes",
    );
  }
  await assert.rejects(
    store.as(buyer, (c) =>
      c.query(
        "INSERT INTO campus.orders SELECT * FROM campus.orders WHERE false",
      ),
    ),
    { code: "42501" },
  );
  await market.cancelOrder(buyer, o.id, {}, key());
  for (const actor of [buyer, seller]) {
    await assert.rejects(
      store.as(actor, (c) =>
        c.query(
          "UPDATE campus.orders SET state='pending_payment' WHERE id=$1",
          [o.id],
        ),
      ),
      { code: "23514" },
    );
    await assert.rejects(
      store.as(actor, (c) =>
        c.query(
          "UPDATE campus.orders SET reserved_until=now()+interval '1 hour' WHERE id=$1",
          [o.id],
        ),
      ),
      { code: "23514" },
    );
  }
  for (const clause of [
    "quantity=quantity+1",
    "total_cents=total_cents+1",
    "terms='{}'",
    "shipping_address='{}'",
  ]) {
    await assert.rejects(
      f.owner.query(`UPDATE campus.orders SET ${clause} WHERE id=$1`, [o.id]),
      { code: "23514" },
    );
  }
  const grants = (
    await f.owner.query(`SELECT
    has_function_privilege('campus_app','campus.cancel_unpaid_order(uuid)','EXECUTE') AS app,
    has_function_privilege('campus_worker','campus.cancel_unpaid_order(uuid)','EXECUTE') AS worker,
    has_function_privilege('campus_auth','campus.cancel_unpaid_order(uuid)','EXECUTE') AS auth,
    has_table_privilege('campus_app','campus.orders','INSERT') AS direct_insert`)
  ).rows[0];
  assert.deepEqual(grants, {
    app: true,
    worker: false,
    auth: false,
    direct_insert: false,
  });
  const functions = (
    await f.owner.query(
      "SELECT proname,prosecdef,proconfig FROM pg_proc WHERE oid IN('campus.cancel_unpaid_order(uuid)'::regprocedure,'campus.create_order_from_quote(uuid,jsonb)'::regprocedure)",
    )
  ).rows;
  assert.ok(
    functions.every(
      (fn) =>
        fn.prosecdef &&
        fn.proconfig.includes("search_path=pg_catalog, campus, pg_temp"),
    ),
  );
  assert.equal(await stock(p), 5);
  assert.equal(await migrate(f.owner), 0);
});

test("cancellation rollback restores both order and inventory; restricted accounts cannot invoke release", async () => {
  const p = await listing();
  const o = await reserve(p);
  await assert.rejects(
    store.as(buyer, async (c) => {
      await c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]);
      throw new Error("Rollback proof");
    }),
    /Rollback proof/,
  );
  assert.equal((await market.getOrder(buyer, o.id)).state, "pending_payment");
  assert.equal(await stock(p), 4);
  try {
    await f.owner.query(
      "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
      [buyer],
    );
    await assert.rejects(
      market.cancelOrder(buyer, o.id, {}, key()),
      businessError("account_restricted", 403),
    );
    await assert.rejects(
      store.as(buyer, (c) =>
        c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]),
      ),
      (error) =>
        error.code === "P0001" && error.message === "account_restricted",
    );
    assert.equal(await stock(p), 4);
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [buyer],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [buyer],
    );
    await assert.rejects(
      market.cancelOrder(buyer, o.id, {}, key()),
      businessError("membership_required", 403),
    );
    await assert.rejects(
      store.as(buyer, (c) =>
        c.query("SELECT * FROM campus.cancel_unpaid_order($1)", [o.id]),
      ),
      (error) =>
        error.code === "P0001" && error.message === "membership_required",
    );
    assert.equal(await stock(p), 4);
  } finally {
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [buyer],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '1 year' WHERE user_id=$1",
      [buyer],
    );
  }
});

test("direct quote-backed creation checks buyer ownership, active membership, snapshots and address before stock changes", async () => {
  const p = await listing();
  const q = await market.quote(
    buyer,
    p.id,
    { quantity: 1, deliveryMethod: "shipping" },
    key(),
  );
  const call = (actor, input = address) =>
    store.as(actor, (c) =>
      c.query("SELECT * FROM campus.create_order_from_quote($1,$2)", [
        q.id,
        JSON.stringify(input),
      ]),
    );
  for (const actor of [seller, other]) {
    await assert.rejects(
      call(actor),
      (error) => error.code === "P0001" && error.message === "not_found",
    );
  }
  await assert.rejects(
    call(null),
    (error) =>
      error.code === "P0001" && error.message === "membership_required",
  );
  for (const invalid of [
    {},
    { ...address, country: "CA" },
    { ...address, unknown: true },
    null,
  ]) {
    await assert.rejects(
      call(buyer, invalid),
      (error) => error.code === "P0001" && error.message === "invalid_input",
    );
  }
  try {
    await f.owner.query(
      "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
      [buyer],
    );
    await assert.rejects(
      call(buyer),
      (error) =>
        error.code === "P0001" && error.message === "account_restricted",
    );
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [buyer],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [buyer],
    );
    await assert.rejects(
      call(buyer),
      (error) =>
        error.code === "P0001" && error.message === "membership_required",
    );
  } finally {
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [buyer],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '1 year' WHERE user_id=$1",
      [buyer],
    );
  }
  await f.owner.query("UPDATE campus.quotes SET unit_cents=1 WHERE id=$1", [
    q.id,
  ]);
  await assert.rejects(
    call(buyer),
    (error) => error.code === "P0001" && error.message === "stale_quote",
  );
  assert.equal(await stock(p), 5);
  assert.equal(
    (
      await f.owner.query("SELECT id FROM campus.orders WHERE quote_id=$1", [
        q.id,
      ])
    ).rowCount,
    0,
  );
});
