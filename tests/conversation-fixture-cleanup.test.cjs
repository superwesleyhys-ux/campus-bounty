const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createFixtureCleanup,
  cleanupSetupFailure,
} = require("./conversation-fixture-cleanup.cjs");
const database = "campus_test_" + "a".repeat(32);
function fake({
  store = true,
  client = true,
  admin = true,
  created = true,
  failing = [],
} = {}) {
  const calls = [];
  const action = (label) => async () => {
    calls.push(label);
    if (failing.includes(label)) throw new Error(`injected ${label}`);
  };
  return {
    calls,
    resources: {
      database,
      adminUrl: "postgres://127.0.0.1/postgres",
      created,
      ...(store ? { store: { close: action("store.close") } } : {}),
      ...(client ? { client: { end: action("client.end") } } : {}),
      ...(admin
        ? {
            admin: {
              end: action("admin.end"),
              query: async (sql) => {
                assert.equal(sql, `DROP DATABASE ${database} WITH (FORCE)`);
                await action("drop")();
              },
            },
          }
        : {}),
    },
  };
}
for (const [stage, options, expected] of [
  [
    "before admin acquisition",
    { admin: false, client: false, store: false, created: false },
    [],
  ],
  [
    "admin connection or CREATE failure",
    { client: false, store: false, created: false },
    ["admin.end"],
  ],
  [
    "after positive CREATE before client",
    { client: false, store: false },
    ["drop", "admin.end"],
  ],
  [
    "client connection or migration failure",
    { store: false },
    ["client.end", "drop", "admin.end"],
  ],
  [
    "service initialization failure",
    {},
    ["store.close", "client.end", "drop", "admin.end"],
  ],
])
  test(`partial setup cleanup: ${stage}`, { timeout: 1000 }, async () => {
    const f = fake(options),
      close = createFixtureCleanup(f.resources);
    const original = new Error(`injected setup failure: ${stage}`);
    await assert.rejects(
      cleanupSetupFailure(original, close),
      (error) => error === original,
    );
    await close();
    assert.deepEqual(f.calls, expected);
  });

test(
  "all cleanup failures are attempted once and retain the original setup cause",
  { timeout: 1000 },
  async () => {
    const f = fake({
      failing: ["store.close", "client.end", "drop", "admin.end"],
    });
    const close = createFixtureCleanup(f.resources),
      original = new Error("original seed failure");
    const first = close();
    assert.equal(close(), first, "concurrent calls share the same teardown");
    await assert.rejects(cleanupSetupFailure(original, close), (error) => {
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors[1].errors.length, 4);
      assert.deepEqual(
        error.errors[1].errors.map((e) => e.cause.message),
        [
          "injected store.close",
          "injected client.end",
          "injected drop",
          "injected admin.end",
        ],
      );
      return true;
    });
    await assert.rejects(first, AggregateError);
    assert.deepEqual(f.calls, [
      "store.close",
      "client.end",
      "drop",
      "admin.end",
    ]);
  },
);

for (const [label, change] of [
  ["unguarded database", { database: "campus_preview" }],
  ["non-loopback admin", { adminUrl: "postgres://example.test/postgres" }],
])
  test(
    `drop guard rejects ${label}, still closes all owned handles`,
    { timeout: 1000 },
    async () => {
      const f = fake();
      Object.assign(f.resources, change);
      await assert.rejects(createFixtureCleanup(f.resources)(), AggregateError);
      assert.deepEqual(f.calls, ["store.close", "client.end", "admin.end"]);
    },
  );

test(
  "normal teardown is idempotent and attempts later releases after one close fails",
  { timeout: 1000 },
  async () => {
    const f = fake({ failing: ["store.close"] }),
      close = createFixtureCleanup(f.resources);
    await assert.rejects(close(), AggregateError);
    await assert.rejects(close(), AggregateError);
    assert.deepEqual(f.calls, [
      "store.close",
      "client.end",
      "drop",
      "admin.end",
    ]);
  },
);
