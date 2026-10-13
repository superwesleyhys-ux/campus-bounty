import test from "node:test";
import assert from "node:assert/strict";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { fixture } from "./fixture.mjs";
import { createStore, member } from "../../backend/db/store.mjs";
import { createAuth } from "../../backend/modules/auth.mjs";
import { createMailWorker } from "../../backend/adapters/mail-worker.mjs";
const f = await fixture(),
  store = createStore(f.urls);
const emails = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, session, callback) {
    let s = "";
    stream.on("data", (d) => (s += d));
    stream.on("end", () => {
      emails.push(s);
      callback();
    });
  },
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const transport = nodemailer.createTransport({
  host: "127.0.0.1",
  port: smtp.server.address().port,
  ignoreTLS: true,
});
let auth, worker;
test.after(async () => {
  transport.close();
  await new Promise((r) => smtp.close(r));
  await store.close();
  await f.close();
});
test("email ownership uses real SMTP, opaque sessions, single-use code and immediate logout", async () => {
  auth = createAuth(store, f.config);
  worker = createMailWorker(store, {
    encryptionKey: f.config.encryptionKey,
    transport,
    from: "Campus <no-reply@campus.example.test>",
  });
  const challenge = await auth.request(
    { email: "ALICE@campus.example.test" },
    "127.0.0.1",
  );
  assert.deepEqual(Object.keys(challenge).sort(), ["challengeId", "message"]);
  const job = (await f.owner.query("SELECT payload FROM campus.mail_jobs"))
    .rows[0];
  assert.ok(!job.payload.includes("alice@"));
  assert.equal(await worker.tick(), true);
  assert.equal(emails.length, 1);
  const code = emails[0].match(/\b\d{6}\b/)[0];
  const result = await auth.verify(
    { challengeId: challenge.challengeId, code, displayName: "Alice" },
    "127.0.0.1",
  );
  assert.equal(result.user.display_name, "Alice");
  assert.ok(result.token.length >= 40);
  const session = await auth.resolve(result.token);
  assert.equal(session.id, result.user.id);
  assert.equal(
    (
      await f.owner.query("SELECT token_hash FROM campus.sessions")
    ).rows[0].token_hash.includes(result.token),
    false,
  );
  await assert.rejects(
    auth.verify(
      { challengeId: challenge.challengeId, code, displayName: "Alice" },
      "127.0.0.1",
    ),
    (e) => e.code === "invalid_code",
  );
  await assert.rejects(
    store.as(session.id, (c) => member(c, session.id, { apply: true })),
    (e) => e.code === "student_verification_required",
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [session.id],
  );
  await assert.rejects(
    store.as(session.id, (c) => member(c, session.id, { write: true })),
    (e) => e.code === "account_restricted",
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [session.id],
  );
  await assert.rejects(
    auth.resolve(result.token),
    (e) => e.code === "unauthenticated",
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='active' WHERE id=$1",
    [session.id],
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 hour' WHERE user_id=$1",
    [session.id],
  );
  await assert.rejects(
    store.as(session.id, (c) => member(c, session.id)),
    (e) => e.code === "membership_required",
  );
  await auth.logout(result.token);
  await assert.rejects(
    auth.resolve(result.token),
    (e) => e.code === "unauthenticated",
  );
});
test("unreviewed domains never receive mail; wrong attempts persist and expiry/review revocation fail closed", async () => {
  const before = emails.length;
  await assert.rejects(
    auth.request({ email: "x@unreviewed.edu" }, "127.0.0.2"),
    (e) => e.status === 422 && e.code === "unsupported_university_email",
  );
  assert.equal(await worker.tick(), false);
  assert.equal(emails.length, before);
  const c = await auth.request(
    { email: "bob@campus.example.test" },
    "127.0.0.3",
  );
  await worker.tick();
  const code = emails.at(-1).match(/\b\d{6}\b/)[0];
  const bad = code === "000000" ? "111111" : "000000";
  for (let n = 0; n < 5; n++)
    await assert.rejects(
      auth.verify(
        { challengeId: c.challengeId, code: bad, displayName: "Bob" },
        "127.0.0.3",
      ),
      (e) => e.code === "invalid_code",
    );
  assert.equal(
    (
      await f.owner.query(
        "SELECT attempts FROM campus.challenges WHERE id=$1",
        [c.challengeId],
      )
    ).rows[0].attempts,
    5,
  );
  await assert.rejects(
    auth.verify(
      { challengeId: c.challengeId, code, displayName: "Bob" },
      "127.0.0.3",
    ),
    (e) => e.code === "invalid_code",
  );
  const expired = await auth.request(
    { email: "exp@campus.example.test" },
    "127.0.0.4",
  );
  await worker.tick();
  const expiredCode = emails.at(-1).match(/\b\d{6}\b/)[0];
  await f.owner.query(
    "UPDATE campus.challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.challengeId],
  );
  await assert.rejects(
    auth.verify(
      { challengeId: expired.challengeId, code: expiredCode, displayName: "E" },
      "127.0.0.4",
    ),
    (e) => e.code === "invalid_code",
  );
  const revoked = await auth.request(
    { email: "rev@campus.example.test" },
    "127.0.0.5",
  );
  await worker.tick();
  const revokedCode = emails.at(-1).match(/\b\d{6}\b/)[0];
  await f.owner.query("UPDATE campus.domains SET enabled=false");
  await assert.rejects(
    auth.verify(
      { challengeId: revoked.challengeId, code: revokedCode, displayName: "R" },
      "127.0.0.5",
    ),
    (e) => e.code === "invalid_code",
  );
  await f.owner.query("UPDATE campus.domains SET enabled=true");
});
test("durable email failure releases lease, retries, then dead-letters without exposing recipient", async () => {
  await auth.request({ email: "retry@campus.example.test" }, "127.0.0.6");
  const failing = createMailWorker(store, {
    encryptionKey: f.config.encryptionKey,
    transport: {
      async sendMail() {
        throw Error("secret SMTP details");
      },
    },
    from: "test@campus.example.test",
  });
  for (let n = 0; n < 5; n++) {
    await f.owner.query(
      "UPDATE campus.mail_jobs SET available_at=now() WHERE status='pending'",
    );
    assert.equal(await failing.tick(), true);
  }
  const job = (
    await f.owner.query(
      "SELECT status,payload,last_error FROM campus.mail_jobs WHERE status='dead'",
    )
  ).rows[0];
  assert.equal(job.status, "dead");
  assert.equal(job.payload, null);
  assert.equal(job.last_error, "delivery_failed");
  for (let n = 0; n < 3; n++)
    await auth.request({ email: "limit@campus.example.test" }, "127.0.0.7");
  await assert.rejects(
    auth.request({ email: "limit@campus.example.test" }, "127.0.0.7"),
    (e) => e.code === "rate_limited",
  );
});
test("expired worker leases stop retrying at the attempt budget even after process crashes", async () => {
  await f.owner.query(
    "UPDATE campus.mail_jobs SET status='dead',payload=NULL WHERE status='pending'",
  );
  await auth.request({ email: "crash@campus.example.test" }, "127.0.0.8");
  await f.owner.query(
    "UPDATE campus.mail_jobs SET status='sending',attempts=5,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE status='pending'",
  );
  assert.equal(await worker.tick(), false);
  const row = (
    await f.owner.query(
      "SELECT status,payload FROM campus.mail_jobs WHERE attempts=5 AND last_error='retry_exhausted'",
    )
  ).rows[0];
  assert.deepEqual(row, { status: "dead", payload: null });
});
