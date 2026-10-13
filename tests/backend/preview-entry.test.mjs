import test from "node:test";
import assert from "node:assert/strict";
import {
  previewFixture,
  previewAvailable,
  enterPreview,
} from "../../backend/modules/preview-entry.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
import { createAuth } from "../../backend/modules/auth.mjs";
const fixture = {
  database: "campus_test_" + "a".repeat(32),
  users: {
    sam: "33333333-3333-4333-8333-333333333333",
    alex: "11111111-1111-4111-8111-111111111111",
    professor: "22222222-2222-4222-8222-222222222222",
  },
};
const read = () => fixture;
function setup() {
  const env = {
    NODE_ENV: "development",
    CAMPUS_BACKEND: "postgres",
    CAMPUS_DEMO: "0",
    CAMPUS_BUILD_DIR: ".next-interaction",
    CAMPUS_ORIGIN: "http://127.0.0.1:3020",
    CAMPUS_SMTP_HOST: "127.0.0.1",
    CAMPUS_SMTP_PORT: "1",
    CAMPUS_MAIL_FROM: "local@campus.example.test",
  };
  const config = {
    production: false,
    origin: env.CAMPUS_ORIGIN,
    cookieName: "campus_session",
    urls: Object.fromEntries(
      ["app", "auth", "worker"].map((role) => {
        const url = `postgresql://campus_${role}:synthetic@127.0.0.1:5443/${fixture.database}`;
        env[`CAMPUS_DB_${role.toUpperCase()}`] = url;
        return [role, url];
      }),
    ),
  };
  const queries = [];
  const users = [
    {
      id: fixture.users.sam,
      email: "sam@campus.example.test",
      display_name: "Sam",
      account_status: "active",
    },
    {
      id: fixture.users.alex,
      email: "alex@campus.example.test",
      display_name: "Alex",
      account_status: "active",
    },
    {
      id: fixture.users.professor,
      email: "professor@campus.example.test",
      display_name: "Professor",
      account_status: "active",
    },
  ];
  const client = {
    async query(sql, args) {
      queries.push({ sql, args });
      return {
        rows: sql.includes("FROM campus.identities")
          ? users
          : sql.includes("RETURNING hits")
            ? [{ hits: 1 }]
            : [],
        rowCount: 1,
      };
    },
  };
  const runtime = {
    config,
    store: { auth: client, authTx: (fn) => fn(client) },
  };
  return { env, config, runtime, queries, users };
}
test("exact disposable configuration and fresh matching metadata only", async () => {
  const { env, config } = setup();
  assert.equal(previewFixture(config, env, read), fixture);
  for (const [key, value] of Object.entries({
    NODE_ENV: "production",
    CAMPUS_BACKEND: "other",
    CAMPUS_DEMO: "1",
    CAMPUS_BUILD_DIR: ".next",
    CAMPUS_ORIGIN: "http://localhost:3020",
    CAMPUS_SMTP_HOST: "smtp.example.test",
    CAMPUS_SMTP_PORT: "1025",
    CAMPUS_MAIL_FROM: "real@example.test",
  }))
    assert.equal(
      previewFixture(config, { ...env, [key]: value }, read),
      null,
      key,
    );
  assert.equal(
    previewFixture({ ...config, production: true }, env, read),
    null,
  );
  assert.equal(
    previewFixture(config, env, () => {
      throw Error("missing");
    }),
    null,
  );
  assert.equal(
    previewFixture(config, env, () => ({
      ...fixture,
      database: "campus_development",
    })),
    null,
  );
  assert.equal(
    previewFixture(config, env, () => ({
      ...fixture,
      users: { alex: fixture.users.alex, professor: fixture.users.alex },
    })),
    null,
  );
  for (const role of ["app", "auth", "worker"])
    for (const change of [
      (u) => u.replace("127.0.0.1", "remote.example.test"),
      (u) => u.replace(fixture.database, "campus_development"),
      (u) => u + "?host=remote.example.test",
      (u) => u.replace("5443", "5555"),
    ]) {
      const url = change(config.urls[role]);
      assert.equal(
        previewFixture(
          { ...config, urls: { ...config.urls, [role]: url } },
          { ...env, [`CAMPUS_DB_${role.toUpperCase()}`]: url },
          read,
        ),
        null,
      );
    }
});
test("unavailable fixture fails closed before querying or opening sessions", async () => {
  const s = setup();
  assert.equal(
    await previewAvailable(
      s.runtime,
      { ...s.env, NODE_ENV: "production" },
      read,
    ),
    false,
  );
  await assert.rejects(
    enterPreview(
      { runtime: s.runtime, body: { role: "student" } },
      { ...s.env, NODE_ENV: "production" },
      read,
    ),
    (e) => e.status === 404,
  );
  assert.equal(s.queries.length, 0);
  s.users.pop();
  assert.equal(await previewAvailable(s.runtime, s.env, read), false);
  await assert.rejects(
    enterPreview(
      { runtime: s.runtime, body: { role: "student" } },
      s.env,
      read,
    ),
    (e) => e.status === 404,
  );
  assert.ok(s.queries.every((q) => !q.sql.includes("INSERT")));
});
test("only three fixed roles; arbitrary identity, token, or unknown fields rejected", async () => {
  for (const body of [
    { role: "admin" },
    { role: "__proto__" },
    { role: "student", userId: fixture.users.professor },
    { role: "publisher", email: "real@berkeley.edu" },
    { role: "student", session: "injected" },
    null,
    {},
  ]) {
    const s = setup();
    await assert.rejects(
      enterPreview({ runtime: s.runtime, body }, s.env, read),
      (e) => e.status === 422,
    );
    assert.equal(s.queries.length, 0);
  }
});
test("role maps to existing fixed identity and rotates HttpOnly session without token response", async () => {
  for (const role of ["student", "applicant", "publisher"]) {
    const s = setup();
    const response = await enterPreview(
      { runtime: s.runtime, body: { role }, token: "old-session" },
      s.env,
      read,
    );
    const body = await response.json();
    assert.equal(
      body.user.id,
      fixture.users[
        role === "student" ? "alex" : role === "applicant" ? "sam" : "professor"
      ],
    );
    assert.deepEqual(Object.keys(body).sort(), ["sample", "user"]);
    assert.match(
      response.headers.get("set-cookie"),
      /^campus_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/,
    );
    assert.ok(
      s.queries.findIndex((q) => q.sql.startsWith("UPDATE campus.sessions")) <
        s.queries.findIndex((q) =>
          q.sql.startsWith("INSERT INTO campus.sessions"),
        ),
    );
    assert.ok(s.queries[0].sql.includes("account_status='active'"));
    assert.ok(s.queries[0].sql.includes("FOR SHARE OF u,i,a"));
  }
});
test("standard endpoint rejects foreign host/origin and never caches availability", async () => {
  const s = setup();
  const route = endpoint(
    async () => s.runtime,
    { method: "POST", public: true },
    (ctx) => enterPreview(ctx, s.env, read),
  );
  for (const [host, origin] of [
    ["evil.test", s.config.origin],
    ["127.0.0.1:3020", "https://evil.test"],
    ["127.0.0.1:3020", ""],
  ]) {
    const r = await route(
      new Request(s.config.origin + "/api/v1/auth/preview", {
        method: "POST",
        headers: { host, origin, "content-type": "application/json" },
        body: JSON.stringify({ role: "student" }),
      }),
    );
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal(s.queries.length, 0);
});
test("normal auth still rejects unapproved email and queues opaque challenge for approved email", async () => {
  const writes = [];
  const store = {
    authTx: (fn) =>
      fn({
        async query(sql, args) {
          writes.push(sql);
          return {
            rows: sql.includes("RETURNING hits")
              ? [{ hits: 1 }]
              : sql.includes("SELECT d.institution_id")
                ? args[0] === "berkeley.edu"
                  ? [{ institution_id: "school" }]
                  : []
                : [],
          };
        },
      }),
  };
  const auth = createAuth(store, {
    otpKey: "a".repeat(64),
    encryptionKey: "b".repeat(64),
  });
  await assert.rejects(
    auth.request({ email: "person@unsupported.test" }, "test"),
    (e) => e.code === "unsupported_university_email",
  );
  const result = await auth.request({ email: "sample@berkeley.edu" }, "test");
  assert.deepEqual(Object.keys(result).sort(), ["challengeId", "message"]);
  assert.ok(
    writes.some((sql) => sql.startsWith("INSERT INTO campus.mail_jobs")),
  );
  assert.ok(
    !writes.some((sql) => sql.startsWith("INSERT INTO campus.sessions")),
  );
});
