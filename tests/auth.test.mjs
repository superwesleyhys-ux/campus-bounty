import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/lib/store.mjs";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "campus-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "db");
  return { s: createStore(path), path };
}
test("verification code is single-use and session revocation takes effect", (t) => {
  const { s } = setup(t);
  const c = s.requestCode("newstudent@berkeley.edu");
  assert.equal(s.sessionUser("invented"), null);
  const token = s.verifyCode(c.challengeId, c.demoCode);
  assert.ok(s.sessionUser(token));
  assert.throws(() => s.verifyCode(c.challengeId, c.demoCode));
  s.logout(token);
  assert.equal(s.sessionUser(token), null);
});
test("five wrong attempts exhaust challenge, including correct subsequent code", (t) => {
  const { s } = setup(t);
  const c = s.requestCode("newstudent@mit.edu");
  for (let i = 0; i < 5; i++)
    assert.throws(() => s.verifyCode(c.challengeId, "000000"));
  assert.throws(() => s.verifyCode(c.challengeId, c.demoCode));
});
test("expired challenge cannot create a session", (t) => {
  const { s, path } = setup(t);
  const c = s.requestCode("another@stanford.edu");
  const db = new DatabaseSync(path);
  db.prepare("UPDATE challenges SET expires=0 WHERE id=?").run(c.challengeId);
  db.close();
  assert.throws(() => s.verifyCode(c.challengeId, c.demoCode));
});
test("email challenge rate limit survives new requests", (t) => {
  const { s } = setup(t);
  for (let i = 0; i < 5; i++) s.requestCode("limited@ucla.edu");
  assert.throws(() => s.requestCode("limited@ucla.edu"));
  assert.throws(() => s.requestCode("outsider@gmail.com"));
});

test("successful verification does not reset hourly request limits", (t) => {
  const { s } = setup(t);
  for (let i = 0; i < 5; i++) {
    const c = s.requestCode("rate@mit.edu");
    s.verifyCode(c.challengeId, c.demoCode);
  }
  assert.throws(() => s.requestCode("rate@mit.edu"));
});
