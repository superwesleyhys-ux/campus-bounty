import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/lib/store.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "campus-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStore(join(dir, "test.db"));
}
const draft = {
  kind: "task",
  title: "Public data cleaning script",
  description: "Clean public data and include setup instructions.",
  amount: "150",
  category: "Research",
  tags: "Python, Data processing",
  requirements: "Deliver scripts\nDeliver test results",
  durationDays: 5,
};
test("publishing persists and enforces auth and positive money", (t) => {
  const s = fixture(t);
  assert.throws(() => s.command(null, "publish", draft));
  const x = s.command("student", "publish", draft);
  assert.ok(x?.id);
  assert.equal(
    s.state("student").tasks.find((y) => y.id === x.id).reward,
    15000,
  );
  assert.throws(() =>
    s.command("student", "publish", { ...draft, amount: "-5" }),
  );
});
test("whole task workflow separates owner, applicant, assignee and payment simulation", (t) => {
  const s = fixture(t);
  const { id } = s.command("professor", "publish", draft);
  s.command("student", "apply", {
    id,
    note: "I have Python experience and can deliver on time.",
  });
  s.command("student", "apply", {
    id,
    note: "Repeated clicks should not create a second application.",
  });
  let item = s.state("professor").tasks.find((x) => x.id === id);
  assert.equal(item.applications.length, 1);
  s.command("professor", "select", { id, applicantId: "student" });
  assert.throws(() =>
    s.command("maker", "select", { id, applicantId: "maker" }),
  );
  s.command("student", "accept", { id });
  s.command("student", "submit", {
    id,
    note: "Scripts and instructions are complete. All 10 checks pass.",
    url: "https://example.com/result",
  });
  assert.throws(() => s.command("student", "approve", { id }));
  s.command("professor", "approve", { id });
  item = s.state("professor").tasks.find((x) => x.id === id);
  assert.equal(item.status, "completed");
  assert.equal(item.paymentStatus, "demo_only");
  assert.throws(() => s.command("professor", "approve", { id }));
});
test("private applications and delivery are not exposed to unrelated members", (t) => {
  const s = fixture(t);
  const { id } = s.command("professor", "publish", draft);
  s.command("student", "apply", {
    id,
    note: "This is a private application for the publisher.",
  });
  assert.equal(
    s.state("maker").tasks.find((x) => x.id === id).applications.length,
    0,
  );
  assert.equal(
    s.state("student").tasks.find((x) => x.id === id).applications.length,
    1,
  );
  assert.throws(() =>
    s.command("professor", "apply", {
      id,
      note: "Cannot apply for my own task",
    }),
  );
});
test("single-item goods cannot sell twice and order belongs only to parties", (t) => {
  const s = fixture(t);
  const { id } = s.command("maker", "publish", {
    kind: "product",
    title: "Used drawing tablet",
    description: "Works well and includes the original pen.",
    amount: "80",
    category: "Pre-owned",
    productType: "physical",
    delivery: "In-person campus pickup",
    tags: "Drawing tablet",
  });
  assert.throws(() => s.command("maker", "buy", { id }));
  s.command("student", "buy", { id });
  assert.throws(() => s.command("professor", "buy", { id }));
  assert.equal(s.state("student").orders.length, 1);
  assert.equal(s.state("professor").orders.length, 0);
  const order = s.state("maker").orders[0];
  s.command("maker", "fulfill", {
    id: order.id,
    note: "Agreed to meet outside the library on Friday",
  });
  s.command("student", "received", { id: order.id });
  assert.equal(s.state("student").orders[0].status, "completed");
});
test("published state survives another store connection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "campus-persist-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "db");
  const s = createStore(file);
  const { id } = s.command("student", "publish", draft);
  assert.ok(
    createStore(file)
      .state("student")
      .tasks.some((x) => x.id === id),
  );
});
test("unsafe delivery URLs are rejected and state stays unchanged", (t) => {
  const s = fixture(t);
  const { id } = s.command("professor", "publish", draft);
  s.command("student", "apply", { id, note: "I can complete this task." });
  s.command("professor", "select", { id, applicantId: "student" });
  s.command("student", "accept", { id });
  assert.throws(() =>
    s.command("student", "submit", {
      id,
      note: "Delivery notes must be at least five characters.",
      url: "javascript:alert(1)",
    }),
  );
  assert.equal(
    s.state("professor").tasks.find((x) => x.id === id).status,
    "active",
  );
});

test("new assignee cannot read an earlier invitee conversation", (t) => {
  const s = fixture(t);
  const { id } = s.command("professor", "publish", draft);
  for (const who of ["student", "maker"])
    s.command(who, "apply", {
      id,
      note: "I can complete this task. Please consider my application.",
    });
  s.command("professor", "select", { id, applicantId: "student" });
  s.command("student", "message", {
    id,
    note: "A private note for the professor and me.",
  });
  s.command("professor", "message", {
    id,
    note: "This is a private reply to the first applicant.",
  });
  s.command("student", "decline", { id });
  s.command("professor", "select", { id, applicantId: "maker" });
  assert.equal(
    s.state("maker").tasks.find((t) => t.id === id).messages.length,
    0,
  );
  assert.equal(
    s.state("professor").tasks.find((t) => t.id === id).messages.length,
    2,
  );
});
