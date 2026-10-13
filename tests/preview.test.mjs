import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRequest,
  createPreviewPool,
  validateAuthStart,
} from "../src/lib/preview.mjs";
import { createStore } from "../src/lib/store.mjs";
import { seed } from "../src/lib/seed.mjs";

test("invalid sign-in requests are rejected before allocating a preview", () => {
  assert.throws(() =>
    validateAuthStart({ action: "request", email: "outsider@gmail.com" }),
  );
  assert.throws(() => validateAuthStart({ action: "quick", id: "invented" }));
  assert.doesNotThrow(() =>
    validateAuthStart({ action: "quick", id: "student" }),
  );
});

test("preview limits apply to email verification, sessions and code requests", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campus-limits-"));
  const store = createStore(join(dir, "test.db"), {
    maxDocumentBytes: Buffer.byteLength(JSON.stringify(seed())) + 10,
    maxSessions: 2,
    maxChallenges: 2,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const challenge = store.requestCode("new-person@mit.edu");
  assert.throws(
    () => store.verifyCode(challenge.challengeId, challenge.demoCode),
    (e) => e.code === "DEMO_LIMIT",
  );
  assert.equal(store.state("professor").users.length, 5);
  store.requestCode("other@mit.edu");
  assert.throws(
    () => store.requestCode("third@mit.edu"),
    (e) => e.code === "DEMO_LIMIT",
  );
  store.quickSession("student");
  store.quickSession("professor");
  assert.throws(
    () => store.quickSession("maker"),
    (e) => e.code === "DEMO_LIMIT",
  );
});

test("inactive preview workspaces expire without removing other files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campus-expiry-"));
  const pool = createPreviewPool(dir, { maxWorkspaces: 1 });
  t.after(() => {
    pool.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const first = pool.create();
  const expired = new Date(Date.now() - 8 * 86400000);
  utimesSync(join(dir, first.id + ".db"), expired, expired);
  const next = pool.create();
  assert.notEqual(next.id, first.id);
  assert.equal(pool.get(first.id), null);
});

test("cloud preview accepts only its configured HTTPS origin", () => {
  const config = { enabled: "1", publicOrigin: "https://preview.example.com" };
  const headers = new Headers({
    host: "preview.example.com",
    origin: config.publicOrigin,
  });
  assert.doesNotThrow(() => checkRequest(headers, config, true));
  headers.set("host", "attacker.example");
  assert.throws(() => checkRequest(headers, config));
  headers.set("host", "preview.example.com");
  headers.set("origin", "https://attacker.example");
  assert.throws(() => checkRequest(headers, config, true));
  assert.throws(() =>
    checkRequest(headers, {
      enabled: "1",
      publicOrigin: "http://preview.example.com",
    }),
  );
  assert.throws(() =>
    checkRequest(headers, { enabled: "0", publicOrigin: config.publicOrigin }),
  );
});

test("preview visitors have separate data and sessions, with bounded stores", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campus-preview-"));
  const pool = createPreviewPool(dir, { maxWorkspaces: 2, maxOpen: 1 });
  t.after(() => {
    pool.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(pool.get("../../secret"), null);
  assert.equal(readdirSync(dir).length, 0);
  const first = pool.create();
  const token = first.store.quickSession("professor");
  const { id: bounty } = first.store.command("professor", "publish", {
    kind: "task",
    title: "Private preview task",
    description: "Only visible inside the first visitor workspace.",
    category: "Research",
    amount: "25",
    durationDays: 3,
    requirements: "Deliver the script",
  });
  const second = pool.create();
  assert.equal(second.store.sessionUser(token), null);
  assert.equal(
    second.store.state("professor").tasks.some((x) => x.id === bounty),
    false,
  );
  assert.equal(pool.get(first.id).sessionUser(token), "professor");
  assert.ok(
    pool
      .get(first.id)
      .state("professor")
      .tasks.some((x) => x.id === bounty),
  );
  assert.throws(
    () => pool.create(),
    (e) => e.code === "DEMO_CAPACITY",
  );
});
