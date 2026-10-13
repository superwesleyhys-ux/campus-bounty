// Fresh engineering identities; actual HTTP boundaries, no blind-trial sessions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium, request } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright",
);
const {
  seedPeople,
  fixtureSessionLogin,
  withFixture,
} = require("./team-browser-support.cjs");
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const output = path.resolve(
    "docs/evidence/interaction-round8/http-probe.json",
  );
  assert.ok(!fs.existsSync(output), "Preserve earlier evidence");
  await withFixture(async (c) =>
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM campus.schema_migrations WHERE name LIKE '012_%'",
        )
      ).rows[0].n,
      1,
    ),
  );
  const [seller, buyer, outsider] = await seedPeople([
    "HTTP engineering seller",
    "HTTP engineering buyer",
    "HTTP engineering outsider",
  ]);
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const fixture = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => {
      const url = connectionString(localConfig(), role, fixture.database);
      assert.equal(new URL(url).hostname, "127.0.0.1");
      return [role, url];
    }),
  );
  const store = createStore(urls),
    market = createMarket(store);
  const browser = await chromium.launch({ headless: true }),
    clients = [];
  const checks = [];
  try {
    const product = await market.publishProduct(
      seller.id,
      {
        title: "HTTP boundary test lamp",
        description: "Synthetic engineering fixture only.",
        priceCents: 1500,
        stock: 1,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      randomUUID(),
    );
    const quote = await market.quote(
      buyer.id,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      randomUUID(),
    );
    const order = await market.order(
      buyer.id,
      { quoteId: quote.id },
      randomUUID(),
    );
    for (let i = 0; i < 4; i++)
      await market.sendMessage(
        seller.id,
        { orderId: order.id, body: `Synthetic HTTP read item ${i + 1}` },
        randomUUID(),
      );
    async function clientFor(person) {
      const context = await browser.newContext();
      try {
        await fixtureSessionLogin(await context.newPage(), person);
        const c = await request.newContext({
          baseURL: "http://127.0.0.1:3020",
          storageState: await context.storageState(),
        });
        clients.push(c);
        return c;
      } finally {
        await context.close();
      }
    }
    const client = await clientFor(buyer),
      other = await clientFor(outsider);
    const guest = await request.newContext({
      baseURL: "http://127.0.0.1:3020",
    });
    clients.push(guest);
    const scope = `orderId=${order.id}`;
    const first = await client.get(`/api/v1/conversations?${scope}&limit=2`);
    assert.equal(first.status(), 200);
    assert.equal(first.headers()["cache-control"], "no-store");
    const page = await first.json();
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    assert.equal(page.participantCount, 2);
    assert.equal(page.participants.length, 2);
    assert.ok(
      page.items.every(
        (m) => m.author.id === seller.id && m.author.role === "seller",
      ),
    );
    const again = await client.get(`/api/v1/conversations?${scope}&limit=2`);
    assert.deepEqual(await again.json(), page);
    const older = await client.get(
      `/api/v1/conversations?${scope}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    assert.equal(older.status(), 200);
    const olderPage = await older.json();
    assert.equal(olderPage.items.length, 2);
    assert.equal(olderPage.nextCursor, null);
    assert.equal(
      new Set([...page.items, ...olderPage.items].map((m) => m.id)).size,
      4,
    );
    checks.push(
      "Authenticated no-store message pages expose all four records without duplicates; repeat GET is stable.",
    );
    const roster = await client.get(
      `/api/v1/conversations/participants?${scope}&limit=1`,
    );
    assert.equal(roster.status(), 200);
    assert.equal(roster.headers()["cache-control"], "no-store");
    const people = await roster.json();
    assert.equal(people.items.length, 1);
    assert.equal(people.participantCount, 2);
    assert.ok(people.nextCursor);
    const last = await client.get(
      `/api/v1/conversations/participants?${scope}&limit=1&cursor=${encodeURIComponent(people.nextCursor)}`,
    );
    const lastPeople = await last.json();
    assert.equal(last.status(), 200);
    assert.equal(lastPeople.items.length, 1);
    assert.equal(lastPeople.nextCursor, null);
    assert.notEqual(lastPeople.items[0].id, people.items[0].id);
    checks.push(
      "Independent participant cursor returns both currently authorized buyer/seller labels with no-store.",
    );
    for (const [route, max] of [
      ["conversations", 50],
      ["conversations/participants", 100],
    ]) {
      for (const query of [
        `${scope}&limit=1&limit=2`,
        `${scope}&unknown=x`,
        `${scope}&cursor=bad`,
        `${scope}&limit=0`,
        `${scope}&limit=${max + 1}`,
        `${scope}&agreementId=${randomUUID()}`,
        `${scope}&orderId=${order.id}`,
        "",
      ]) {
        const res = await client.get(`/api/v1/${route}?${query}`);
        assert.equal(res.status(), 422, query);
        assert.equal((await res.json()).code, "invalid_input");
      }
      assert.equal(
        (await guest.get(`/api/v1/${route}?${scope}`)).status(),
        401,
      );
      assert.equal(
        (await other.get(`/api/v1/${route}?${scope}`)).status(),
        404,
      );
    }
    assert.equal(
      (
        await client.get(
          `/api/v1/conversations?${scope}&cursor=${encodeURIComponent(people.nextCursor)}`,
        )
      ).status(),
      422,
    );
    assert.equal(
      (
        await client.get(
          `/api/v1/conversations/participants?${scope}&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).status(),
      422,
    );
    checks.push(
      "Both routes reject duplicate/unknown/missing/both scopes, malformed/out-of-range input and exchanged cursor kinds; guest and outsider denied.",
    );
    const legacy = await client.get(`/api/v1/messages?${scope}`);
    assert.equal(legacy.status(), 200);
    assert.equal((await legacy.json()).length, 4);
    const badOrigin = await client.post("/api/v1/messages", {
      headers: {
        Origin: "http://invalid.test",
        "Idempotency-Key": randomUUID(),
      },
      data: { orderId: order.id, body: "Rejected HTTP command" },
    });
    assert.equal(badOrigin.status(), 403);
    assert.equal(
      (await (await client.get(`/api/v1/messages?${scope}`)).json()).length,
      4,
    );
    checks.push(
      "Legacy array read remains compatible; wrong-origin send rejected without message change.",
    );
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          passed: true,
          checks,
          scope:
            "Actual loopback HTTP with fresh engineering users. Synthetic market fixture prepared through business methods; session verifier used, external OTP delivery/payment excluded. No credentials or private response content saved.",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log("4 grouped real HTTP boundary checks passed.");
  } finally {
    await Promise.all(clients.map((c) => c.dispose()));
    await browser.close();
    await store.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
