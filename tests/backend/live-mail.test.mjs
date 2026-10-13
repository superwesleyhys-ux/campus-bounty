import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createAuth } from "../../backend/modules/auth.mjs";
import { createMailWorker } from "../../backend/adapters/mail-worker.mjs";
import {
  mailConfig,
  senderAddress,
} from "../../backend/adapters/mail-config.mjs";

test("external SMTP always requires credentials and verified TLS, including a local live-mail pilot", () => {
  const env = {
    CAMPUS_SMTP_HOST: "smtp.example.test",
    CAMPUS_MAIL_FROM: "Campus Bounty <verify@sender.example.test>",
    CAMPUS_SMTP_PORT: "587",
    CAMPUS_SMTP_USER: "fixture",
    CAMPUS_SMTP_PASSWORD: "fixture-only",
  };
  for (const production of [false, true]) {
    const smtp = mailConfig(env, production);
    assert.equal(smtp.secure, false);
    assert.equal(smtp.requireTLS, true);
    assert.equal(smtp.ignoreTLS, false);
    assert.equal(smtp.tls.rejectUnauthorized, true);
    assert.equal(smtp.tls.minVersion, "TLSv1.2");
    assert.throws(
      () => mailConfig({ ...env, CAMPUS_SMTP_PASSWORD: "" }, production),
      /SMTP/,
    );
    assert.equal(
      mailConfig({ ...env, CAMPUS_SMTP_PORT: "465" }, production).secure,
      true,
    );
  }
  const local = mailConfig(
    {
      ...env,
      CAMPUS_SMTP_HOST: "127.0.0.1",
      CAMPUS_SMTP_USER: "",
      CAMPUS_SMTP_PASSWORD: "",
    },
    false,
  );
  assert.equal(local.ignoreTLS, true);
  assert.throws(
    () =>
      mailConfig(
        { ...env, CAMPUS_SMTP_HOST: "127.0.0.1", CAMPUS_SMTP_PASSWORD: "" },
        true,
      ),
    /SMTP/,
  );
  for (const from of [
    "a@example.test,b@example.test",
    "a@example.test\r\nBcc:b@example.test",
    "Group:a@example.test;",
    "Name, Other <a@example.test>",
    "not-an-email",
  ])
    assert.throws(() => senderAddress(from), /sender/);
});

test("mail worker requires acceptance for the exact recipient and preserves retry expiry and message identity", async (t) => {
  const f = await fixture(),
    store = createStore(f.urls),
    auth = createAuth(store, f.config);
  t.after(async () => {
    await store.close();
    await f.close();
  });
  const to = "receipt@campus.example.test";
  await auth.request({ email: to }, randomUUID());
  const job = (
    await f.owner.query("SELECT id,expires_at FROM campus.mail_jobs")
  ).rows[0];
  const delivered = [];
  let receipt;
  const worker = createMailWorker(store, {
    encryptionKey: f.config.encryptionKey,
    from: "Campus Bounty <verify@sender.example.test>",
    transport: {
      async sendMail(message) {
        delivered.push(message);
        return receipt;
      },
    },
  });
  for (const bad of [
    undefined,
    { accepted: [], rejected: [to] },
    { accepted: ["other@campus.example.test"], rejected: [] },
  ]) {
    receipt = bad;
    await f.owner.query(
      "UPDATE campus.mail_jobs SET available_at=now() WHERE id=$1",
      [job.id],
    );
    await worker.tick();
    const state = (
      await f.owner.query(
        "SELECT status,payload,last_error FROM campus.mail_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(state.status, "pending");
    assert.ok(state.payload);
    assert.equal(state.last_error, "delivery_failed");
  }
  receipt = { accepted: [to], rejected: [] };
  await f.owner.query(
    "UPDATE campus.mail_jobs SET available_at=now() WHERE id=$1",
    [job.id],
  );
  await worker.tick();
  const accepted = (
    await f.owner.query(
      "SELECT status,payload,attempts FROM campus.mail_jobs WHERE id=$1",
      [job.id],
    )
  ).rows[0];
  assert.deepEqual(accepted, { status: "sent", payload: null, attempts: 4 });
  assert.equal(new Set(delivered.map((m) => m.messageId)).size, 1);
  assert.equal(delivered[0].messageId, `<${job.id}@sender.example.test>`);
  assert.equal(new Set(delivered.map((m) => m.text)).size, 1);
  assert.ok(delivered[0].text.includes(job.expires_at.toISOString()));
});
