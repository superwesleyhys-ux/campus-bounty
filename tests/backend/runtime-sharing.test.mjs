import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime, processSharedStore } from "../../backend/runtime.mjs";
const env = {
  NODE_ENV: "production",
  CAMPUS_BACKEND: "postgres",
  CAMPUS_ORIGIN: "https://campus.example.test",
  CAMPUS_OTP_KEY: "a".repeat(64),
  CAMPUS_MAIL_KEY: "b".repeat(64),
  CAMPUS_DB_APP:
    "postgresql://campus_app:synthetic@db.example.test/campus?sslmode=verify-full",
  CAMPUS_DB_AUTH:
    "postgresql://campus_auth:synthetic@db.example.test/campus?sslmode=verify-full",
  CAMPUS_DB_WORKER:
    "postgresql://campus_worker:synthetic@db.example.test/campus?sslmode=verify-full",
  CAMPUS_SMTP_HOST: "smtp.example.test",
  CAMPUS_SMTP_PORT: "465",
  CAMPUS_SMTP_USER: "synthetic",
  CAMPUS_SMTP_PASSWORD: "synthetic",
  CAMPUS_MAIL_FROM: "Campus <mail@campus.example.test>",
};
test("separate module instances share only pools and reject changed database configuration", async () => {
  const urls = {
    app: env.CAMPUS_DB_APP,
    auth: env.CAMPUS_DB_AUTH,
    worker: env.CAMPUS_DB_WORKER,
  };
  const store = processSharedStore(urls);
  try {
    const reloaded =
      await import("../../backend/runtime.mjs?runtime-sharing-test");
    assert.equal(reloaded.processSharedStore({ ...urls }), store);
    assert.equal(store.app.options.max, 5);
    assert.equal(store.auth.options.max, 5);
    assert.equal(store.worker.options.max, 5);
    assert.throws(
      () =>
        reloaded.processSharedStore({
          ...urls,
          app: urls.app.replace("/campus?", "/other?"),
        }),
      /configuration changed/,
    );
  } finally {
    await store.close();
    delete globalThis[Symbol.for("campus.backend.shared-store.v1")];
  }
});
test("each shared-store runtime rechecks roles/domains and creates fresh business facades", async () => {
  let roles = 0,
    domains = 0,
    closes = 0;
  const store = {
    verifyRoles: async () => {
      roles++;
    },
    auth: {
      query: async () => {
        domains++;
        return { rows: [{ count: "1" }] };
      },
    },
    close: async () => {
      closes++;
    },
  };
  const [a, b] = await Promise.all([
    createRuntime(env, { sharedStore: store }),
    createRuntime(env, { sharedStore: store }),
  ]);
  assert.equal(a.store, b.store);
  assert.notEqual(a.market, b.market);
  assert.notEqual(a.auth, b.auth);
  assert.equal(roles, 2);
  assert.equal(domains, 2);
  assert.equal(closes, 0);
});
test("failed role or production domain checks cannot close another runtime’s shared pools", async () => {
  let closes = 0;
  const store = {
    verifyRoles: async () => {
      throw Error("unsafe fixture role");
    },
    close: async () => {
      closes++;
    },
  };
  await assert.rejects(
    createRuntime(env, { sharedStore: store }),
    /unsafe fixture role/,
  );
  store.verifyRoles = async () => {};
  store.auth = { query: async () => ({ rows: [{ count: "0" }] }) };
  await assert.rejects(
    createRuntime(env, { sharedStore: store }),
    /No reviewed campus domains/,
  );
  assert.equal(closes, 0);
});
