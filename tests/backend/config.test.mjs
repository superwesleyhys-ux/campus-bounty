import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../../backend/config.mjs";
test("shared runtime fails closed without credentials, TLS and non-demo mode", () => {
  assert.throws(() => readConfig({}), /CAMPUS_BACKEND/);
  const env = {
    NODE_ENV: "production",
    CAMPUS_BACKEND: "postgres",
    CAMPUS_ORIGIN: "https://campus.example.test",
    CAMPUS_OTP_KEY: "a".repeat(64),
    CAMPUS_MAIL_KEY: "b".repeat(64),
    CAMPUS_DB_APP:
      "postgresql://campus_app:secret@db.example.test/campus?sslmode=verify-full",
    CAMPUS_DB_AUTH:
      "postgresql://campus_auth:secret@db.example.test/campus?sslmode=verify-full",
    CAMPUS_DB_WORKER:
      "postgresql://campus_worker:secret@db.example.test/campus?sslmode=verify-full",
    CAMPUS_SMTP_HOST: "smtp.example.test",
    CAMPUS_SMTP_PORT: "465",
    CAMPUS_SMTP_USER: "smtp-user",
    CAMPUS_SMTP_PASSWORD: "secret",
    CAMPUS_MAIL_FROM: "Campus <mail@campus.example.test>",
  };
  assert.equal(readConfig(env).origin, "https://campus.example.test");
  assert.throws(() => readConfig({ ...env, CAMPUS_DEMO: "1" }), /demo/);
  assert.throws(
    () => readConfig({ ...env, CAMPUS_ORIGIN: "http://campus.example.test" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readConfig({
        ...env,
        CAMPUS_DB_APP: env.CAMPUS_DB_APP.replace("verify-full", "disable"),
      }),
    /verify-full/,
  );
  assert.throws(() => readConfig({ ...env, CAMPUS_SMTP_PASSWORD: "" }), /SMTP/);
});
