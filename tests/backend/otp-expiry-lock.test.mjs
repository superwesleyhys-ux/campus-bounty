// Adapted from the independent ChatGPT review (PostgreSQL NOT_RUN there).
// Locally reproduced before the fix and retained as a real PostgreSQL regression.
// Uses only the project's isolated disposable database fixture.
// No SMTP worker, delivery, installation, or database daemon is started here.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const repo = resolve(
  process.env.CAMPUS_REVIEW_REPO ||
    fileURLToPath(new URL("../../", import.meta.url)),
);
const source = (p) => import(pathToFileURL(resolve(repo, p)));
const { fixture } = await source("tests/backend/fixture.mjs");
const { createStore } = await source("backend/db/store.mjs");
const { createAuth } = await source("backend/modules/auth.mjs");
const { mac } = await source("backend/crypto.mjs");

test("A-new: OTP must not mint a session after same-email lock wait crosses expiry", async (t) => {
  const f = await fixture(),
    store = createStore(f.urls),
    auth = createAuth(store, f.config);
  t.after(async () => {
    await f.owner.query("ROLLBACK").catch(() => {});
    await store.close();
    await f.close();
  });
  const challengeId = randomUUID(),
    email = "otp-lock-" + randomUUID() + "@campus.example.test";
  await f.owner.query(
    "INSERT INTO campus.challenges(id,email,code_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1200 milliseconds')",
    [challengeId, email, mac(f.config.otpKey, challengeId + ":123456")],
  );
  await f.owner.query("BEGIN");
  await f.owner.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    email,
  ]);
  const ownerPid = (await f.owner.query("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid;
  const pending = auth
    .verify(
      { challengeId, code: "123456", displayName: "OTP lock fixture" },
      randomUUID(),
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  let blocked = false;
  for (let i = 0; i < 100; i++) {
    await f.owner.query("SELECT pg_stat_clear_snapshot()");
    const r = await f.owner.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_auth' AND $1=ANY(pg_blocking_pids(pid))",
      [ownerPid],
    );
    if (r.rowCount) {
      blocked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(
    blocked,
    true,
    "verification must reach the email advisory lock before expiry",
  );
  let proof;
  for (let i = 0; i < 180; i++) {
    proof = (
      await f.owner.query(
        "SELECT expires_at,clock_timestamp() AS wall_time,expires_at<clock_timestamp() AS expired FROM campus.challenges WHERE id=$1",
        [challengeId],
      )
    ).rows[0];
    if (proof.expired) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(
    proof.expired,
    true,
    "OTP must expire while the advisory lock remains held",
  );
  await f.owner.query("COMMIT");
  const result = await pending;
  const state = (
    await f.owner.query(
      "SELECT (SELECT count(*)::int FROM campus.sessions) AS sessions,(SELECT consumed_at IS NOT NULL FROM campus.challenges WHERE id=$1) AS consumed",
      [challengeId],
    )
  ).rows[0];
  console.log(
    "OTP lock evidence:",
    JSON.stringify({
      expiresAt: proof.expires_at,
      wallTimeBeforeUnlock: proof.wall_time,
      result: result.error
        ? { error: result.error.code }
        : { sessionUser: result.value.user.id },
      ...state,
    }),
  );
  assert.equal(
    result.error?.code,
    "invalid_code",
    "expected expired OTP rejection after the identity lock",
  );
  assert.deepEqual(state, { sessions: 0, consumed: false });
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int AS n FROM campus.identities WHERE email=$1",
        [email],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await f.owner.query("SELECT count(*)::int AS n FROM campus.users")).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await f.owner.query("SELECT count(*)::int AS n FROM campus.affiliations"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT attempts FROM campus.challenges WHERE id=$1",
        [challengeId],
      )
    ).rows[0].attempts,
    1,
  );
});
