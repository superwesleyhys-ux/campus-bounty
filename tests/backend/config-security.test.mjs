import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readConfig } from "../../backend/config.mjs";

function environment(production = true) {
  return {
    NODE_ENV: production ? "production" : "development",
    CAMPUS_BACKEND: "postgres",
    CAMPUS_ORIGIN: production
      ? "https://campus.example.test"
      : "http://127.0.0.1:3020",
    CAMPUS_OTP_KEY: "a".repeat(64),
    CAMPUS_MAIL_KEY: "b".repeat(64),
    CAMPUS_SMTP_HOST: "smtp.example.test",
    CAMPUS_SMTP_USER: "fixture",
    CAMPUS_SMTP_PASSWORD: "synthetic",
    CAMPUS_MAIL_FROM: "test@campus.example.test",
    ...Object.fromEntries(
      ["app", "auth", "worker"].map((role) => [
        "CAMPUS_DB_" + role.toUpperCase(),
        `postgresql://campus_${role}:synthetic@${production ? "db.example.test" : "127.0.0.1:5443"}/campus?sslmode=${production ? "verify-full" : "disable"}`,
      ]),
    ),
  };
}

for (const role of ["app", "auth", "worker"]) {
  test(`${role}: ambiguous and overriding database parameters are rejected`, () => {
    const name = "CAMPUS_DB_" + role.toUpperCase();
    for (const suffix of [
      "&sslmode=disable",
      "&sslmode=no-verify",
      "&sslmode=verify-full",
      "&ssl%6dode=disable",
      "&ssl=0",
      "&user=postgres",
      "&host=remote.example.test",
      "&port=9999",
      "&password=other",
      "&options=-c%20role%3Dpostgres",
    ]) {
      const env = environment();
      env[name] += suffix;
      assert.throws(() => readConfig(env), /database|PostgreSQL/i, suffix);
    }
  });
}

test("approved production URLs enable certificate and hostname verification in the actual pg driver", () => {
  const config = readConfig(environment());
  for (const [role, connectionString] of Object.entries(config.urls)) {
    // Construct the installed driver without connecting or using any real credentials.
    const actual = new pg.Client({ connectionString }).connectionParameters;
    assert.equal(actual.user, "campus_" + role);
    assert.equal(actual.host, "db.example.test");
    assert.ok(actual.ssl);
    assert.notEqual(actual.ssl.rejectUnauthorized, false);
    assert.equal(actual.ssl.checkServerIdentity, undefined);
  }
  const env = environment();
  // IPv6 brackets are normalized by pg; URL-encoded password characters survive.
  env.CAMPUS_DB_APP =
    "postgresql://campus_app:synthetic%40%23@[::1]/campus?sslmode=verify-full";
  const actual = new pg.Client({ connectionString: readConfig(env).urls.app })
    .connectionParameters;
  assert.equal(actual.host, "::1");
  assert.equal(actual.password, "synthetic@#");
});

test("development cannot override loopback via query parameters", () => {
  const env = environment(false);
  assert.equal(readConfig(env).production, false);
  env.CAMPUS_DB_APP += "&host=remote.example.test";
  assert.throws(() => readConfig(env), /database|PostgreSQL/i);
});
