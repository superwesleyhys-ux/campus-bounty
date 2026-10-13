import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixture } from "./fixture.mjs";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
assert.equal(
  new URL(connectionString(localConfig(), "migrator")).hostname,
  "127.0.0.1",
);
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import {
  conversationSearchQuery,
  conversationMessageQuery,
  conversationHttpQuery,
} from "../../backend/modules/conversations.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";

const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
assert.match(
  f.owner.connectionParameters.database,
  /^campus_test_[a-f0-9]{32}$/,
);
test.after(async () => {
  await store.close();
  await f.close();
});
const code = (value) => (error) => error.code === value;
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
async function scope(type) {
  const owner = await f.user("Current owner"),
    sender = await f.user("Current sender"),
    outsider = await f.user("Foreign person");
  let id;
  if (type === "agreement") {
    const task = await market.publishTask(
      owner,
      {
        title: "Discovery task",
        category: "Research",
        description: "Synthetic",
        rewardCents: 100,
        milestones: [
          { title: "Stage", amountCents: 100, deliverable: "Evidence" },
        ],
      },
      key(),
    );
    const app = await market.apply(
      sender,
      task.id,
      { proposal: "Synthetic plan" },
      key(),
    );
    await market.inviteApplicant(owner, app.id, {}, key());
    id = (await market.acceptInvitation(sender, app.id, {}, key())).id;
  } else {
    const product = await market.publishProduct(
      owner,
      {
        title: "Discovery item",
        description: "Synthetic",
        priceCents: 100,
        stock: 2,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      key(),
    );
    const quote = await market.quote(
      sender,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      key(),
    );
    id = (await market.order(sender, { quoteId: quote.id }, key())).id;
  }
  return {
    type,
    id,
    owner,
    sender,
    outsider,
    query: { [`${type}Id`]: id },
    column: type === "agreement" ? "agreement_id" : "order_id",
  };
}
async function seed(s) {
  await store.as(s.sender, (c) =>
    c.query(
      `INSERT INTO campus.messages(sender_id,${s.column},body,created_at)
     SELECT $1,$2,CASE WHEN n<=37 THEN 'Old NEEDLE body '||n ELSE 'Recent ordinary body '||n END,
     '2026-01-01T00:00:00.123001Z'::timestamptz+(n/5)*interval '1 microsecond'
     FROM generate_series(1,143)n`,
      [s.sender, s.id],
    ),
  );
  return (
    await f.owner.query(
      `SELECT id,body,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM campus.messages WHERE ${s.column}=$1 ORDER BY created_at DESC,id DESC`,
      [s.id],
    )
  ).rows;
}
const search = (s, extra = {}) =>
  market.searchConversation(s.owner, { ...s.query, q: "needle", ...extra });
const exact = (s, id, actor = s.owner) =>
  market.conversationMessage(actor, { ...s.query, messageId: id });
const notification = (s) => market.notifications(s.owner, { limit: "50" });

for (const type of ["agreement", "order"]) {
  test(`${type}: all-history search finds old matches, paginates microsecond ties, binds cursor and returns full bodies`, async () => {
    const s = await scope(type),
      expected = await seed(s);
    assert.equal((await market.messages(s.owner, s.query)).length, 100);
    assert.ok(
      (await market.messages(s.owner, s.query)).every(
        (m) => !m.body.includes("NEEDLE"),
      ),
    );
    const first = await search(s, { q: "  NeEdLe  ", limit: "7" });
    assert.equal(first.q, "NeEdLe");
    assert.equal(first.limit, 7);
    assert.equal("total" in first, false);
    assert.ok(first.nextCursor);
    let page = first,
      all = [...page.items];
    while (page.nextCursor) {
      page = await search(s, { limit: "7", cursor: page.nextCursor });
      all.push(...page.items);
    }
    assert.equal(all.length, 37);
    assert.equal(new Set(all.map((m) => m.id)).size, 37);
    assert.deepEqual(
      all.map(({ author, ...m }) => m),
      expected.filter((m) => m.body.includes("NEEDLE")),
    );
    assert.ok(
      all.every(
        (m) =>
          m.author.displayName === "Current sender" &&
          /\.\d{6}Z$/.test(m.createdAt),
      ),
    );
    assert.deepEqual(Object.keys(all[0]).sort(), [
      "author",
      "body",
      "createdAt",
      "id",
    ]);
    assert.deepEqual(await search(s, { q: "no match" }), {
      scope: { type, id: s.id },
      q: "no match",
      items: [],
      limit: 20,
      nextCursor: null,
    });
    assert.equal((await search(s, { limit: "50" })).items.length, 37);
    assert.equal((await search(s)).limit, 20);
    await market.sendMessage(
      s.sender,
      { ...s.query, body: "NEW needle arrival" },
      key(),
    );
    assert.equal((await search(s)).items[0].body, "NEW needle arrival");
    assert.deepEqual(
      (
        await search(s, { q: " NEEDLE ", limit: "7", cursor: first.nextCursor })
      ).items.map((m) => m.id),
      all.slice(7, 14).map((m) => m.id),
    );
    for (const input of [
      { ...s.query, q: "ordinary", cursor: first.nextCursor },
      { [`${type}Id`]: key(), q: "needle", cursor: first.nextCursor },
      {
        [type === "agreement" ? "orderId" : "agreementId"]: s.id,
        q: "needle",
        cursor: first.nextCursor,
      },
      {
        ...s.query,
        q: "needle",
        cursor: (await market.conversation(s.owner, { ...s.query, limit: "2" }))
          .nextCursor,
      },
    ])
      await assert.rejects(
        market.searchConversation(s.owner, input),
        code("invalid_input"),
      );
    await assert.rejects(
      market.conversation(s.owner, { ...s.query, cursor: first.nextCursor }),
      code("invalid_input"),
    );
    const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url"));
    for (const change of [
      { id: key() },
      { createdAt: "2026-01-01T00:00:00.120000Z" },
      { id: expected[0].id, createdAt: expected[0].createdAt },
    ])
      await assert.rejects(
        search(s, { cursor: encode({ ...decoded, ...change }) }),
        code("invalid_input"),
      );
    await assert.rejects(
      market.searchConversation(s.outsider, { ...s.query, q: "needle" }),
      code("not_found"),
    );
  });

  test(`${type}: exact selected message has chronological nearest neighbors and accurate edge flags`, async () => {
    const s = await scope(type),
      rows = (await seed(s)).reverse();
    for (const index of [0, 5, 10, 11, 70, 132, 133, 142]) {
      const result = await exact(s, rows[index].id);
      assert.equal(result.message.id, rows[index].id);
      assert.deepEqual(
        result.older.map((m) => m.id),
        rows.slice(Math.max(0, index - 10), index).map((m) => m.id),
      );
      assert.deepEqual(
        result.newer.map((m) => m.id),
        rows.slice(index + 1, index + 11).map((m) => m.id),
      );
      assert.equal(result.hasOlder, index > 10);
      assert.equal(result.hasNewer, rows.length - index - 1 > 10);
      assert.equal(result.contextLimit, 10);
      assert.deepEqual(Object.keys(result).sort(), [
        "contextLimit",
        "hasNewer",
        "hasOlder",
        "message",
        "newer",
        "older",
        "scope",
      ]);
    }
    const other = await scope(type);
    const different = await market.sendMessage(
      other.sender,
      { ...other.query, body: "Other scope" },
      key(),
    );
    await assert.rejects(exact(s, different.id), code("not_found"));
    await assert.rejects(exact(s, key()), code("not_found"));
    await assert.rejects(exact(s, rows[0].id, s.outsider), code("not_found"));
    const before = await notification(s);
    await exact(s, rows[0].id);
    await search(s);
    assert.deepEqual(
      await notification(s),
      before,
      "discovery never acknowledges notifications",
    );
  });

  test(`${type}: restricted and expired readers retain search/context, locked readers do not${type === "agreement" ? "; removed agreement signers are denied" : ""}`, async () => {
    const s = await scope(type);
    if (type === "agreement") {
      s.owner = await f.user("Removable frozen signer");
      await f.owner.query(
        "INSERT INTO campus.agreement_members VALUES($1,$2)",
        [s.id, s.owner],
      );
    }
    const sent = await market.sendMessage(
      s.sender,
      { ...s.query, body: "needle for current readers" },
      key(),
    );
    for (const state of ["restricted", "active"]) {
      await f.owner.query(
        "UPDATE campus.users SET account_status=$2 WHERE id=$1",
        [s.owner, state],
      );
      await f.owner.query(
        "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
        [s.owner],
      );
      assert.equal((await search(s)).items[0].id, sent.id);
      assert.equal((await exact(s, sent.id)).message.id, sent.id);
      assert.equal(
        (await notification(s)).items.find((n) => n.kind === "message.received")
          .messageContext.messageId,
        sent.id,
      );
    }
    await f.owner.query(
      "UPDATE campus.users SET account_status='locked' WHERE id=$1",
      [s.owner],
    );
    await assert.rejects(search(s), code("account_locked"));
    await assert.rejects(exact(s, sent.id), code("account_locked"));
    await assert.rejects(notification(s), code("account_locked"));
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [s.owner],
    );
    // Ordinary sequential removal of a frozen signer in the disposable fixture.
    // Order counterparties are immutable; account locking above exercises denial.
    if (type === "agreement") {
      await f.owner.query(
        "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
        [s.id, s.owner],
      );
      await assert.rejects(search(s), code("not_found"));
      await assert.rejects(exact(s, sent.id), code("not_found"));
      const redacted = (await notification(s)).items.find(
        (n) => n.kind === "message.received",
      );
      assert.equal(redacted.target, null);
      assert.equal(redacted.messageContext, null);
    }
  });
}

test("literal punctuation and Unicode queries have no wildcard or regex semantics", async () => {
  const s = await scope("agreement");
  const bodies = [
    "Budget 50%_\\ literal 😀中文 ÉCOLE .* [x] ' OR 1=1 --",
    "Budget 50ABC literal other",
    "😀".repeat(160),
    "x".repeat(4000),
  ];
  for (const body of bodies)
    await market.sendMessage(s.sender, { ...s.query, body }, key());
  for (const q of [
    "50%_\\",
    "%",
    "_",
    "\\",
    "😀中文",
    ".*",
    "[x]",
    "' OR 1=1 --",
    "école",
  ]) {
    const page = await search(s, { q });
    assert.deepEqual(
      page.items.map((m) => m.body),
      [bodies[0]],
    );
  }
  assert.equal(
    (await search(s, { q: "😀".repeat(160) })).items[0].body,
    bodies[2],
  );
  assert.equal((await search(s, { q: "xxxx" })).items[0].body.length, 4000);
});

test("current author rename and absent participant redact IDs, while exact event/target mapping alone resolves notifications", async () => {
  const s = await scope("agreement"),
    other = await scope("order");
  const body = "😀".repeat(159) + "中" + "tail private",
    sent = await market.sendMessage(s.sender, { ...s.query, body }, key());
  const initial = (await notification(s)).items.find(
    (n) => n.kind === "message.received",
  );
  assert.deepEqual(Object.keys(initial.messageContext).sort(), [
    "author",
    "createdAt",
    "messageId",
    "preview",
    "truncated",
  ]);
  assert.equal(initial.messageContext.preview, "😀".repeat(159) + "中");
  assert.equal(Array.from(initial.messageContext.preview).length, 160);
  assert.equal(initial.messageContext.truncated, true);
  assert.equal(initial.messageContext.messageId, sent.id);
  assert.equal(initial.navigationAnchor, null);
  assert.equal(initial.workContext, null);
  await store.as(s.sender, (c) =>
    c.query("UPDATE campus.users SET display_name='Renamed now' WHERE id=$1", [
      s.sender,
    ]),
  );
  assert.equal(
    (await exact(s, sent.id)).message.author.displayName,
    "Renamed now",
  );
  assert.equal(
    (await search(s, { q: "中" })).items[0].author.displayName,
    "Renamed now",
  );
  assert.equal(
    (await notification(s)).items.find((n) => n.id === initial.id)
      .messageContext.author.displayName,
    "Renamed now",
  );
  const ack = await market.readNotification(s.owner, initial.id, {}, key());
  assert.equal(ack.messageContext.author.displayName, "Renamed now");
  assert.ok(ack.readAt);
  const short = await market.sendMessage(
    s.sender,
    { ...s.query, body: "x".repeat(160) },
    key(),
  );
  const shortN = (await notification(s)).items.find(
    (n) => n.messageContext?.messageId === short.id,
  );
  assert.equal(shortN.messageContext.truncated, false);
  const mapped = [];
  for (const [event, targetType, targetId, kind] of [
    ["message:" + key(), "agreement", s.id, "message.received"],
    ["message:not-a-uuid", "agreement", s.id, "message.received"],
    ["message:" + sent.id + ":extra", "agreement", s.id, "message.received"],
    ["legacy-event", "agreement", s.id, "message.received"],
    ["message:" + sent.id, "order", other.id, "message.received"],
    ["message:" + sent.id, "agreement", s.id, "agreement.completed"],
  ]) {
    // Different synthetic recipients avoid the immutable event/recipient uniqueness.
    const recipient =
      targetType === "order" ? other.owner : await f.user("Mapping reader");
    await f.owner.query("INSERT INTO campus.agreement_members VALUES($1,$2)", [
      s.id,
      recipient,
    ]);
    const row = (
      await f.owner.query(
        "INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [recipient, event, kind, targetType, targetId],
      )
    ).rows[0];
    mapped.push([recipient, row.id]);
  }
  for (const [recipient, id] of mapped) {
    const n = (await market.notifications(recipient)).items.find(
      (n) => n.id === id,
    );
    assert.equal(n.targetAvailable, true);
    assert.equal(n.messageContext, null);
  }
  const legacyReader = await f.user("Legacy mapping reader");
  await f.owner.query("INSERT INTO campus.agreement_members VALUES($1,$2)", [
    s.id,
    legacyReader,
  ]);
  await f.owner.query(
    "INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id,created_at) VALUES($1,$2,'message.received','agreement',$3,'2020-01-01')",
    [legacyReader, "message:" + sent.id, s.id],
  );
  assert.equal(
    (await market.notifications(legacyReader)).items[0].messageContext
      .messageId,
    sent.id,
  );
  await f.owner.query(
    "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
    [s.id, s.sender],
  );
  const selected = (await exact(s, sent.id)).message,
    results = await search(s, { q: "中" }),
    n = (await notification(s)).items.find((n) => n.id === initial.id);
  assert.equal(selected.author, null);
  assert.equal(results.items[0].author, null);
  assert.equal(n.messageContext.author, null);
  assert.ok(!JSON.stringify({ selected, results, n }).includes(s.sender));
  assert.ok(!JSON.stringify(n).includes("event_key"));
  const stored = JSON.stringify(
    (
      await f.owner.query(
        "SELECT * FROM campus.notifications WHERE recipient_id=$1",
        [s.owner],
      )
    ).rows,
  );
  for (const secret of [body, "Renamed now", "preview", "messageContext"])
    assert.ok(!stored.includes(secret));
});

test("strict search/message query and route-input errors use existing no-store problem contract", async () => {
  const id = key(),
    valid = { agreementId: id, q: "needle" };
  for (const bad of [
    {},
    { q: "x" },
    { ...valid, orderId: key() },
    { ...valid, q: "" },
    { ...valid, q: " \n " },
    { ...valid, q: "😀".repeat(161) },
    { ...valid, q: "a\0b" },
    { ...valid, q: 7 },
    { ...valid, q: "x".repeat(161) },
    { ...valid, extra: "x" },
    { ...valid, limit: "0" },
    { ...valid, limit: "51" },
    { ...valid, limit: "01" },
    { ...valid, limit: 1 },
    { ...valid, limit: "1.0" },
    { ...valid, cursor: "" },
    { ...valid, cursor: "bad" },
    { ...valid, cursor: "a".repeat(513) },
    { ...valid, agreementId: "not-uuid" },
  ])
    assert.throws(() => conversationSearchQuery(bad), code("invalid_input"));
  for (const bad of [
    {},
    { agreementId: id },
    { agreementId: id, messageId: "bad" },
    { agreementId: id, orderId: key(), messageId: key() },
    { agreementId: id, messageId: key(), cursor: "x" },
    { agreementId: id, messageId: key(), limit: "10" },
  ])
    assert.throws(() => conversationMessageQuery(bad), code("invalid_input"));
  const s = await scope("order"),
    sent = await market.sendMessage(
      s.sender,
      { ...s.query, body: "needle" },
      key(),
    );
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "session" },
    auth: { resolve: async () => ({ id: s.owner }) },
  };
  for (const [path, method, params] of [
    ["search", "searchConversation", { ...s.query, q: "needle" }],
    ["message", "conversationMessage", { ...s.query, messageId: sent.id }],
  ]) {
    const handler = endpoint(
      async () => runtime,
      { method: "GET" },
      ({ actor, request }) =>
        market[method](actor, conversationHttpQuery(request)),
    );
    const request = (suffix) =>
      new Request(
        `http://127.0.0.1:3020/api/v1/conversations/${path}?${new URLSearchParams(params)}${suffix}`,
        { headers: { host: "127.0.0.1:3020" } },
      );
    const ok = await handler(request(""));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    for (const suffix of [
      "&unknown=1",
      `&orderId=${s.id}`,
      path === "search" ? "&q=needle" : `&messageId=${sent.id}`,
    ]) {
      const response = await handler(request(suffix));
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "invalid_input");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const source = await readFile(
      new URL(
        `../../src/app/api/v1/conversations/${path}/route.js`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(
      source.includes(
        `runtime.market.${method}(actor, conversationHttpQuery(request))`,
      ),
    );
  }
});

test("database Unicode folding finds identical dotted I and binds equivalent-query cursors", async () => {
  const query = "İ";
  const folded = (
    await f.owner.query("SELECT lower($1::text) AS value", [query])
  ).rows[0].value;
  // This fixture reproduces I1: PostgreSQL and JavaScript fold U+0130 differently.
  assert.notEqual(folded, query.toLowerCase());
  for (const type of ["agreement", "order"]) {
    const s = await scope(type);
    for (let n = 0; n < 5; n++)
      await market.sendMessage(s.sender, { ...s.query, body: `İ${n}` }, key());
    const first = await search(s, { q: query, limit: "2" });
    assert.equal(first.q, query);
    assert.equal(
      first.items.length,
      2,
      "an identical Unicode substring must match",
    );
    assert.ok(first.nextCursor);
    const next = await search(s, {
      q: folded,
      limit: "2",
      cursor: first.nextCursor,
    });
    const originalNext = await search(s, {
      q: query,
      limit: "2",
      cursor: first.nextCursor,
    });
    assert.deepEqual(next.items, originalNext.items);
    const last = await search(s, {
      q: query,
      limit: "2",
      cursor: next.nextCursor,
    });
    const ids = [...first.items, ...next.items, ...last.items].map((m) => m.id);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
    assert.equal(last.nextCursor, null);
    await assert.rejects(
      search(s, { q: query.toLowerCase(), cursor: first.nextCursor }),
      code("invalid_input"),
    );
    await assert.rejects(
      search(s, { q: "different", cursor: first.nextCursor }),
      code("invalid_input"),
    );
  }
});
