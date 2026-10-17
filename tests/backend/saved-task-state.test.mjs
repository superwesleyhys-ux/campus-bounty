import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
import { historyHttpQuery } from "../../backend/modules/workspace-history.mjs";
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
const owner = await f.user("Exact saved publisher"),
  person = await f.user("Exact saved reader"),
  other = await f.user("Other exact reader");
const body = {
  title: "Exact saved synthetic",
  category: "Research",
  description: "Local saved-state test",
  rewardCents: 100,
  milestones: [{ title: "Draft", deliverable: "Notes", amountCents: 100 }],
};
const ids = [];
for (let i = 0; i < 105; i++) {
  const task = await market.publishTask(
    owner,
    { ...body, title: `Exact saved ${i}` },
    key(),
  );
  ids.push(task.id);
  await market.saveTask(person, task.id, {}, key());
}
const unsaved = (
  await market.publishTask(
    owner,
    { ...body, title: "Unsaved exact bounty" },
    key(),
  )
).id;
test("exact old/direct bounty state remains true beyond latest100, with ordinary unsave/readback and restore", async () => {
  assert.equal((await market.savedTasks(person)).length, 100);
  assert.equal(
    (await market.savedTasks(person)).some((x) => x.id === ids[0]),
    false,
  );
  assert.equal((await market.task(person, ids[0])).id, ids[0]);
  assert.deepEqual(await market.savedTaskState(person, ids[0]), {
    id: ids[0],
    saved: true,
  });
  let cursor, old;
  do {
    const page = await market.workspaceHistory(person, {
      scope: "saved",
      ...(cursor ? { cursor } : {}),
    });
    old ||= page.items.find((x) => x.id === ids[0]);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(old.id, ids[0]);
  assert.deepEqual(await market.savedTaskState(person, old.id), {
    id: ids[0],
    saved: true,
  });
  await market.unsaveTask(person, ids[0], {}, key());
  assert.deepEqual(await market.savedTaskState(person, ids[0]), {
    id: ids[0],
    saved: false,
  });
  await market.saveTask(person, ids[0], {}, key());
  assert.equal((await market.savedTaskState(person, ids[0])).saved, true);
});
test("unsaved and second actor absence are exact, never borrowed from list origin", async () => {
  assert.deepEqual(await market.savedTaskState(person, unsaved), {
    id: unsaved,
    saved: false,
  });
  assert.deepEqual(await market.savedTaskState(other, ids[0]), {
    id: ids[0],
    saved: false,
  });
  await market.saveTask(other, unsaved, {}, key());
  assert.equal((await market.savedTaskState(other, unsaved)).saved, true);
  assert.equal((await market.savedTaskState(person, unsaved)).saved, false);
  await assert.rejects(
    market.savedTaskState(person, key()),
    (e) => e.status === 404,
  );
  await assert.rejects(
    market.savedTaskState(person, "invalid"),
    (e) => e.status === 422,
  );
});
test("GET wrapper returns bounded exact DTO and rejects duplicate/unknown queries", async () => {
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "campus_session" },
    auth: { resolve: async () => ({ id: person }) },
  };
  const handler = endpoint(
    async () => runtime,
    { method: "GET" },
    ({ actor, request, params }) =>
      market.savedTaskState(actor, params.id, historyHttpQuery(request)),
  );
  const get = (q) =>
    handler(
      new Request(`http://127.0.0.1:3020/api/v1/saved/tasks/${ids[0]}${q}`, {
        headers: { host: "127.0.0.1:3020" },
      }),
      { params: { id: ids[0] } },
    );
  const result = await get("");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { id: ids[0], saved: true });
  for (const q of ["?scope=saved", "?limit=100", "?actor=" + other, "?x=1&x=2"])
    assert.equal((await get(q)).status, 422);
});
test("current account and campus gates apply to exact state independently of saved membership", async () => {
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [person],
  );
  assert.equal((await market.savedTaskState(person, ids[0])).saved, true);
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [person],
  );
  await assert.rejects(
    market.savedTaskState(person, ids[0]),
    (e) => e.code === "membership_required",
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [other],
  );
  await assert.rejects(
    market.savedTaskState(other, unsaved),
    (e) => e.code === "account_locked",
  );
  assert.equal((await market.savedTaskState(owner, ids[0])).saved, false);
});
