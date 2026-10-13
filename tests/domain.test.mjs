import test from "node:test";
import assert from "node:assert/strict";
import { parseSchoolEmail, cents, nextTaskState } from "../src/lib/domain.mjs";
test("school email checks exact reviewed domain, preserves local part", () => {
  assert.deepEqual(parseSchoolEmail(" Alex+research@BERKELEY.EDU "), {
    email: "Alex+research@berkeley.edu",
    school: "UC Berkeley",
    domain: "berkeley.edu",
  });
  for (const email of [
    "a@berkeley.edu.attacker.com",
    "a@gmail.com",
    "a@fake.edu",
    "a@lab.berkeley.edu",
    "a@@mit.edu",
  ])
    assert.throws(() => parseSchoolEmail(email));
});
test("money converts decimal text to positive integer cents without truncation", () => {
  assert.equal(cents("125.50"), 12550);
  assert.equal(cents("75"), 7500);
  for (const amount of ["-1", "0", "1.005", "Infinity", "1e4", "100001", "abc"])
    assert.throws(() => cents(amount));
});
test("assignment requires separate assignee confirmation before submission", () => {
  assert.equal(nextTaskState("open", "select", "owner"), "invited");
  assert.equal(nextTaskState("invited", "accept", "assignee"), "active");
  assert.equal(nextTaskState("active", "submit", "assignee"), "review");
  assert.equal(nextTaskState("review", "approve", "owner"), "completed");
  assert.throws(() => nextTaskState("open", "submit", "assignee"));
  assert.throws(() => nextTaskState("review", "approve", "assignee"));
  assert.throws(() => nextTaskState("completed", "approve", "owner"));
});
test("revision requests retain a legal path to re-delivery", () => {
  assert.equal(nextTaskState("review", "revise", "owner"), "active");
  assert.equal(nextTaskState("open", "cancel", "owner"), "cancelled");
  assert.throws(() => nextTaskState("active", "cancel", "owner"));
});

test("Object prototype properties cannot masquerade as a school", () => {
  assert.throws(() => parseSchoolEmail("reviewer@constructor"));
});
