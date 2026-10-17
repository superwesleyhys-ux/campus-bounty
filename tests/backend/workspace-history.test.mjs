import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { historyHttpQuery } from "../../backend/modules/workspace-history.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
const f = await fixture();
for (const url of Object.values(f.urls)) {
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.match(new URL(url).pathname, /^\/campus_test_[a-f0-9]{32}$/);
}
const store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const owner = await f.user("History publisher"),
  person = await f.user("History participant"),
  outsider = await f.user("Outside history");
const ids = {
  applications: [],
  agreements: [],
  orders: [],
  posted: [],
  selling: [],
  saved: [],
};
const taskBody = {
  title: "PRIVATE HISTORY BOUNTY",
  category: "Research",
  description: "Synthetic bounded history",
  rewardCents: 100,
  milestones: [{ title: "Draft", deliverable: "Notes", amountCents: 100 }],
};
// Ordinary services share a single app-role fixture transaction, giving actual
// exact timestamp ties without modifying immutable timestamps or raw inserts.
await store.as(owner, async (c) => {
  const batch = createMarket({
    ...store,
    as: async (actor, fn) => {
      await c.query("SELECT set_config('campus.actor_id',$1,true)", [actor]);
      return fn(c);
    },
  });
  for (let i = 0; i < 105; i++) {
    const task = await batch.publishTask(
      owner,
      { ...taskBody, title: `${taskBody.title} ${i}` },
      key(),
    );
    const app = await batch.apply(
      person,
      task.id,
      { proposal: `History proposal ${i}` },
      key(),
    );
    await batch.inviteApplicant(owner, app.id, {}, key());
    const agreement = await batch.acceptInvitation(person, app.id, {}, key());
    const product = await batch.publishProduct(
      owner,
      {
        title: `PRIVATE HISTORY ITEM ${i}`,
        description: "Synthetic",
        priceCents: 100,
        stock: 1,
        deliveryMethods: ["pickup"],
      },
      key(),
    );
    const quote = await batch.quote(
      person,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      key(),
    );
    const order = await batch.order(person, { quoteId: quote.id }, key());
    await batch.cancelOrder(person, order.id, {}, key());
    await batch.saveTask(person, task.id, {}, key());
    for (const [scope, id] of Object.entries({
      applications: app.id,
      agreements: agreement.id,
      orders: order.id,
      posted: task.id,
      selling: product.id,
      saved: task.id,
    }))
      ids[scope].push(id);
  }
});
async function collect(actor, scope, limit = "20") {
  const items = [];
  let cursor;
  do {
    const page = await market.workspaceHistory(actor, {
      scope,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    assert.ok(page.items.length <= Number(limit));
    assert.equal(page.scope, scope);
    assert.equal(page.limit, Number(limit));
    assert.equal("total" in page, false);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
const bad = (error) => error.status === 422;

test("all six scopes traverse 105 exact timestamp ties once, respecting app RLS and immutable UUID order", async () => {
  for (const scope of Object.keys(ids)) {
    const actor = ["posted", "selling"].includes(scope) ? owner : person;
    const items = await collect(actor, scope);
    assert.equal(items.length, 105, scope);
    assert.equal(new Set(items.map((x) => x.id)).size, 105, scope);
    assert.deepEqual(
      items.map((x) => x.id),
      [...ids[scope]].sort().reverse(),
      scope,
    );
    assert.deepEqual(
      (await collect(outsider, scope)).map((x) => x.id),
      [],
      scope,
    );
    const first = await market.workspaceHistory(actor, { scope });
    assert.equal(first.limit, 20);
    const decoded = JSON.parse(
      Buffer.from(first.nextCursor, "base64url").toString(),
    );
    const table =
      { posted: "tasks", selling: "products", saved: "tasks" }[scope] || scope;
    const timestamp = (
      await f.owner.query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value FROM campus.${table} WHERE id=$1`,
        [first.items.at(-1).id],
      )
    ).rows[0].value;
    assert.equal(decoded.createdAt, timestamp);
    assert.match(decoded.createdAt, /\.\d{6}Z$/);
    await assert.rejects(
      market.workspaceHistory(outsider, { scope, cursor: first.nextCursor }),
      bad,
    );
    await assert.rejects(
      market.workspaceHistory(actor, {
        scope: scope === "orders" ? "agreements" : "orders",
        cursor: first.nextCursor,
      }),
      bad,
    );
    const lastId = items.at(-1).id;
    const detail =
      scope === "applications"
        ? await market.application(actor, lastId)
        : scope === "agreements"
          ? await market.agreement(actor, lastId)
          : scope === "orders"
            ? await market.getOrder(actor, lastId)
            : scope === "selling"
              ? await market.product(actor, lastId)
              : await market.task(actor, lastId);
    assert.equal(detail.id, lastId);
    assert.equal((await collect(actor, scope, "50")).length, 105);
  }
  assert.ok(
    (await collect(person, "applications")).every(
      (x) => x.state === "accepted",
    ),
  );
  assert.ok(
    (await collect(person, "orders")).every((x) => x.state === "cancelled"),
  );
  assert.equal(
    (await market.workspaceHistory(owner, { scope: "applications" })).items
      .length,
    0,
    "existing myApplications ownership semantics retained",
  );
});

test("cursor anchors remain stable when newer records arrive; a valid empty older page can recover", async () => {
  const first = await market.workspaceHistory(owner, { scope: "posted" });
  const newTask = await market.publishTask(
    owner,
    { ...taskBody, title: "New after page one" },
    key(),
  );
  const following = [];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await market.workspaceHistory(owner, {
      scope: "posted",
      cursor,
    });
    following.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    [...first.items, ...following].map((x) => x.id),
    [...ids.posted].sort().reverse(),
  );
  assert.equal(
    (await market.workspaceHistory(owner, { scope: "posted" })).items[0].id,
    newTask.id,
  );
  const emptyCursor = Buffer.from(
    JSON.stringify({
      actor: owner,
      scope: "posted",
      createdAt: "1900-01-01T00:00:00.000001Z",
      id: key(),
    }),
  ).toString("base64url");
  assert.deepEqual(
    (
      await market.workspaceHistory(owner, {
        scope: "posted",
        cursor: emptyCursor,
      })
    ).items,
    [],
  );
});

test("HTTP boundary rejects duplicate/unknown/malformed query keys and actor/scope cursors, and returns real service pages", async () => {
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "campus_session" },
    auth: { resolve: async () => ({ id: person }) },
  };
  const handler = endpoint(
    async () => runtime,
    { method: "GET" },
    ({ runtime, actor, request }) =>
      runtime.market.workspaceHistory(actor, historyHttpQuery(request)),
  );
  const get = (query) =>
    handler(
      new Request(`http://127.0.0.1:3020/api/v1/workspace/history?${query}`, {
        headers: { host: "127.0.0.1:3020" },
      }),
    );
  for (const query of [
    "",
    "scope=unknown",
    "scope=orders&scope=orders",
    "scope=orders&limit=1&limit=2",
    "scope=orders&cursor=a&cursor=b",
    "scope=orders&extra=1",
    ...["0", "51", "-1", "01", "1.5", "1e1", "", "Infinity"].map(
      (x) => `scope=orders&limit=${x}`,
    ),
    "scope=orders&cursor=garbage",
    "scope=orders&cursor=",
    "scope=orders&cursor=+++",
    "scope=orders&cursor=" + "x".repeat(513),
  ]) {
    const r = await get(query);
    assert.equal(r.status, 422, query);
    assert.equal((await r.json()).code, "invalid_input");
  }
  const cursor = (await market.workspaceHistory(owner, { scope: "orders" }))
    .nextCursor;
  assert.equal((await get(`scope=orders&cursor=${cursor}`)).status, 422);
  const own = (await market.workspaceHistory(person, { scope: "orders" }))
    .nextCursor;
  assert.equal((await get(`scope=agreements&cursor=${own}`)).status, 422);
  const good = await get("scope=orders&limit=50");
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal((await good.json()).items.length, 50);
});

test("legacy array consumers and public catalog contracts remain compatible", async () => {
  assert.equal((await market.myApplications(person)).length, 100);
  assert.equal((await market.agreements(person)).length, 100);
  assert.equal((await market.orders(person)).length, 100);
  assert.equal((await market.savedTasks(person)).length, 100);
  const catalog = await market.tasks(person, {
    q: "PRIVATE HISTORY",
    category: "Research",
    sort: "amount_asc",
    offset: 100,
    limit: 5,
  });
  assert.equal(catalog.items.length, 5);
  assert.equal(catalog.total, 105);
  assert.equal(catalog.offset, 100);
  const products = await market.products(person, {
    q: "PRIVATE HISTORY ITEM",
    sort: "amount_desc",
    offset: 100,
    limit: 5,
  });
  assert.equal(products.items.length, 5);
  assert.equal(products.total, 105);
});

test("frozen application membership survives team departure and ignores later members", async () => {
  const captain = await f.user("Team captain"),
    member = await f.user("Frozen participant"),
    later = await f.user("Later participant");
  let team = await market.createTeam(
    captain,
    {
      name: "History snapshot",
      context: {
        purpose: "Synthetic",
        activities: "Read",
        timeCommitment: "One hour",
        projectContext: "",
      },
    },
    key(),
  );
  team = await market.inviteMember(
    captain,
    team.id,
    { expectedRevision: team.revision, userId: member },
    key(),
  );
  team = await market.acceptMembership(
    member,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  const task = await market.publishTask(owner, taskBody, key());
  const app = await market.apply(
    captain,
    task.id,
    { proposal: "Frozen proposal", teamId: team.id },
    key(),
  );
  team = await market.leaveTeam(
    member,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  team = await market.inviteMember(
    captain,
    team.id,
    { expectedRevision: team.revision, userId: later },
    key(),
  );
  await market.acceptMembership(
    later,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  await market.withdrawApplication(captain, app.id, {}, key());
  assert.deepEqual(
    (await collect(member, "applications")).map((x) => x.id),
    [app.id],
  );
  assert.deepEqual(await collect(later, "applications"), []);
});

test("expired accounts retain all private terminal history and terms, without catalog titles; locked accounts denied", async () => {
  // Fixture-only activation supplies a historic funded agreement without payment.
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [ids.agreements[0]],
  );
  const a = await market.agreement(owner, ids.agreements[0]),
    m = a.milestones[0];
  const submitted = await market.submitMilestone(
    person,
    m.id,
    {
      content: "Historical work",
      expectedVersion: m.version,
      expectedRevision: m.revision,
    },
    key(),
  );
  await market.acceptMilestone(
    owner,
    m.id,
    {
      submissionId: submitted.submission.id,
      expectedVersion: submitted.milestone.version,
      expectedRevision: submitted.milestone.revision,
    },
    key(),
  );
  for (const actor of [owner, person])
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [actor],
    );
  for (const scope of ["applications", "agreements", "orders"]) {
    const rows = await collect(person, scope);
    assert.equal(rows.length, 105);
    if (scope === "applications") {
      assert.ok(rows.every((x) => x.task_title === null));
      assert.ok(!JSON.stringify(rows).includes("PRIVATE HISTORY BOUNTY"));
    } else assert.ok(rows.every((x) => x.terms));
  }
  assert.equal(
    (await collect(person, "agreements")).find(
      (x) => x.id === ids.agreements[0],
    ).state,
    "completed",
  );
  assert.equal(
    (await market.agreement(person, ids.agreements[0])).terms.taskTitle,
    "PRIVATE HISTORY BOUNTY 0",
  );
  for (const scope of ["posted", "selling", "saved"])
    await assert.rejects(
      market.workspaceHistory(person, { scope }),
      (e) => e.code === "membership_required",
    );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [person],
  );
  assert.equal((await collect(person, "orders")).length, 105);
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [person],
  );
  for (const scope of Object.keys(ids))
    await assert.rejects(
      market.workspaceHistory(person, { scope }),
      (e) => e.code === "account_locked",
    );
});
