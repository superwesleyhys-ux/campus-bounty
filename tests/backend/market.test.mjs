const teamBackground = {
  purpose: "Synthetic research",
  activities: "Read and discuss sources",
  timeCommitment: "One hour weekly",
  projectContext: "",
};
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
const f = await fixture(),
  store = createStore(f.urls);
let market;
const owner = await f.user("Professor"),
  captain = await f.user("Captain"),
  student = await f.user("Student"),
  stranger = await f.user("Stranger");
const key = () => randomUUID();
const taskBody = {
  title: "Map campus trees",
  category: "Research",
  description: "Field survey",
  rewardCents: 10000,
  milestones: [
    { title: "Survey", amountCents: 4000, deliverable: "Dataset" },
    { title: "Report", amountCents: 6000, deliverable: "Written analysis" },
  ],
};
let agreement, team, task;
test.after(async () => {
  await store.close();
  await f.close();
});
test("shared listings, team consent, immutable milestone budget, invite and one winning agreement", async () => {
  market = createMarket(store);
  team = await market.createTeam(
    captain,
    { name: "Research team", context: teamBackground },
    key(),
  );
  await market.inviteMember(
    captain,
    team.id,
    { userId: student, expectedRevision: team.revision },
    key(),
  );
  await market.acceptMembership(
    student,
    team.id,
    { expectedRevision: team.revision + 1 },
    key(),
  );
  task = await market.publishTask(owner, taskBody, key());
  assert.equal((await market.tasks(captain, {})).items[0].id, task.id);
  assert.equal((await market.tasks(stranger, {})).items[0].id, task.id);
  await assert.rejects(
    market.apply(owner, task.id, { proposal: "Self", teamId: null }, key()),
    (e) => e.code === "self_application",
  );
  await assert.rejects(
    market.publishTask(owner, { ...taskBody, rewardCents: 9999 }, key()),
    (e) => e.code === "invalid_milestone_budget",
  );
  const application = await market.apply(
    captain,
    task.id,
    { proposal: "We will deliver", teamId: team.id },
    key(),
  );
  await assert.rejects(
    market.inviteApplicant(owner, application.id, {}, key()),
    (e) => e.code === "team_consent_required",
  );
  await market.consentApplication(student, application.id, {}, key());
  assert.equal((await market.applications(stranger, task.id)).length, 0);
  await market.inviteApplicant(owner, application.id, {}, key());
  const attempt = () =>
    market.acceptInvitation(captain, application.id, {}, "accept-invitation");
  const both = await Promise.all([attempt(), attempt()]);
  assert.equal(both[0].id, both[1].id);
  agreement = both[0];
  const result = await market.agreement(student, agreement.id);
  assert.equal(result.members.length, 2);
  assert.equal(result.milestones.length, 2);
  assert.equal(result.state, "awaiting_funding");
  assert.equal(
    result.milestones.reduce((sum, m) => sum + m.amount_cents, 0),
    10000,
  );
  await assert.rejects(
    market.agreement(stranger, agreement.id),
    (e) => e.code === "not_found",
  );
  await assert.rejects(
    market.submitMilestone(
      student,
      result.milestones[0].id,
      { content: "Dataset", expectedVersion: 0, expectedRevision: 1 },
      key(),
    ),
    (e) => e.code === "funding_required",
  );
  await assert.rejects(
    f.owner.query("UPDATE campus.agreements SET terms='{}' WHERE id=$1", [
      agreement.id,
    ]),
    (e) => e.code === "23514",
  );
});
test("versioned team milestone submissions and owner acceptance cannot skip or overwrite versions", async () => {
  // Test-only administrative funding fixture. No production endpoint grants this state.
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [agreement.id],
  );
  const result = await market.agreement(student, agreement.id),
    m = result.milestones[0];
  const submission = await market.submitMilestone(
    student,
    m.id,
    { content: "Dataset v1", expectedVersion: 0, expectedRevision: 1 },
    key(),
  );
  assert.equal(submission.submission.version, 1);
  await assert.rejects(
    market.submitMilestone(
      student,
      m.id,
      { content: "Lost update", expectedVersion: 0, expectedRevision: 1 },
      key(),
    ),
    (e) => e.code === "stale_revision",
  );
  await assert.rejects(
    market.acceptMilestone(captain, m.id, { submissionId: submission.receipt.submissionId, expectedVersion: 1, expectedRevision: 2 }, key()),
    (e) => e.code === "not_owner",
  );
  await market.acceptMilestone(owner, m.id, { submissionId: submission.receipt.submissionId, expectedVersion: 1, expectedRevision: 2 }, key());
  await assert.rejects(
    market.submitMilestone(
      student,
      m.id,
      { content: "Overwrite accepted work", expectedVersion: 1, expectedRevision: 3 },
      key(),
    ),
    (e) => e.code === "invalid_state",
  );
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.submissions SET content='edited' WHERE id=$1",
      [submission.receipt.submissionId],
    ),
    (e) => e.code === "23514",
  );
});
let product, order;
test("pickup and shipping quotes, private addresses and concurrent inventory reservation never oversell", async () => {
  product = await market.publishProduct(
    owner,
    {
      title: "Lab stand",
      description: "One stand",
      priceCents: 1000,
      stock: 1,
      deliveryMethods: ["pickup", "shipping"],
      shippingCents: 250,
    },
    key(),
  );
  await assert.rejects(
    market.quote(
      owner,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      key(),
    ),
    (e) => e.code === "self_purchase",
  );
  const q1 = await market.quote(
    captain,
    product.id,
    { quantity: 1, deliveryMethod: "shipping" },
    key(),
  );
  const q2 = await market.quote(
    student,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const address = {
    name: "Student",
    line1: "1 Test Way",
    city: "Test City",
    region: "CA",
    postalCode: "00000",
    country: "US",
  };
  await assert.rejects(
    market.order(captain, { quoteId: q1.id }, key()),
    (e) => e.code === "shipping_address_required",
  );
  const results = await Promise.allSettled([
    market.order(captain, { quoteId: q1.id, shippingAddress: address }, key()),
    market.order(student, { quoteId: q2.id }, key()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.code === "out_of_stock",
    ).length,
    1,
  );
  order = results.find((r) => r.status === "fulfilled").value;
  assert.equal(
    (
      await f.owner.query("SELECT stock FROM campus.products WHERE id=$1", [
        product.id,
      ])
    ).rows[0].stock,
    0,
  );
  await assert.rejects(
    market.getOrder(stranger, order.id),
    (e) => e.code === "not_found",
  );
  const view = await market.getOrder(owner, order.id);
  assert.equal(view.state, "pending_payment");
  if (view.delivery_method === "shipping")
    assert.equal(view.shipping_address.line1, "1 Test Way");
  await assert.rejects(
    market.fulfillOrder(
      owner,
      order.id,
      { carrier: "USPS", trackingNumber: "TEST123" },
      key(),
    ),
    (e) => e.code === "payment_required",
  );
  await f.owner.query(
    "UPDATE campus.orders SET reserved_until=now()-interval '1 second' WHERE id=$1",
    [order.id],
  );
  assert.equal(await market.expireReservations(), 1);
  assert.equal(await market.expireReservations(), 0);
  assert.equal(
    (
      await f.owner.query("SELECT stock FROM campus.products WHERE id=$1", [
        product.id,
      ])
    ).rows[0].stock,
    1,
  );
});
test("business uniqueness, stale quotes, messaging privacy and membership suspension", async () => {
  const q = await market.quote(
    student,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  await f.owner.query(
    "UPDATE campus.products SET revision=revision+1 WHERE id=$1",
    [product.id],
  );
  await assert.rejects(
    market.order(student, { quoteId: q.id }, key()),
    (e) => e.code === "stale_quote",
  );
  await market.sendMessage(
    captain,
    { agreementId: agreement.id, body: "Private research update" },
    key(),
  );
  assert.equal(
    (await market.messages(student, { agreementId: agreement.id })).length,
    1,
  );
  await assert.rejects(
    market.messages(stranger, { agreementId: agreement.id }),
    (e) => e.code === "not_found",
  );
  await market.saveTask(student, task.id, {}, key());
  assert.equal((await market.savedTasks(student)).length, 1);
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 hour' WHERE user_id=$1",
    [stranger],
  );
  await assert.rejects(
    market.publishTask(stranger, taskBody, key()),
    (e) => e.code === "membership_required",
  );
});
test("shipping and pickup fulfillment preserve quote uniqueness and buyer-only receipt", async () => {
  const address = {
    name: "Buyer",
    line1: "2 Campus Way",
    city: "Test City",
    region: "CA",
    postalCode: "00000",
    country: "US",
  };
  for (const method of ["shipping", "pickup"]) {
    const q = await market.quote(
      student,
      product.id,
      { quantity: 1, deliveryMethod: method },
      key(),
    );
    const body = {
      quoteId: q.id,
      ...(method === "shipping" ? { shippingAddress: address } : {}),
    };
    const o = await market.order(student, body, key());
    const repeat = await market.order(student, body, key());
    assert.equal(o.id, repeat.id);
    assert.equal(
      (
        await store.as(captain, (c) =>
          c.query("SELECT id FROM campus.orders WHERE id=$1", [o.id]),
        )
      ).rowCount,
      0,
    );
    await f.owner.query("UPDATE campus.orders SET state='paid' WHERE id=$1", [
      o.id,
    ]);
    const shipped = await market.fulfillOrder(
      owner,
      o.id,
      method === "shipping"
        ? { carrier: "USPS", trackingNumber: "LOCAL-TEST" }
        : {},
      key(),
    );
    assert.equal(
      shipped.state,
      method === "shipping" ? "shipped" : "ready_for_pickup",
    );
    await assert.rejects(
      market.completeOrder(owner, o.id, {}, key()),
      (e) => e.code === "not_buyer",
    );
    assert.equal(
      (await market.completeOrder(student, o.id, {}, key())).state,
      "completed",
    );
    await f.owner.query(
      "UPDATE campus.products SET stock=stock+1 WHERE id=$1",
      [product.id],
    );
  }
});
test("two invited applicants cannot create two agreements for the same task", async () => {
  const t = await market.publishTask(owner, taskBody, key());
  const a = await market.apply(
    captain,
    t.id,
    { proposal: "First", teamId: null },
    key(),
  );
  const b = await market.apply(
    student,
    t.id,
    { proposal: "Second", teamId: null },
    key(),
  );
  await market.inviteApplicant(owner, a.id, {}, key());
  await market.inviteApplicant(owner, b.id, {}, key());
  const r = await Promise.allSettled([
    market.acceptInvitation(captain, a.id, {}, key()),
    market.acceptInvitation(student, b.id, {}, key()),
  ]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    r.filter(
      (x) => x.status === "rejected" && x.reason.code === "task_contracted",
    ).length,
    1,
  );
  assert.equal(
    (
      await f.owner.query("SELECT id FROM campus.agreements WHERE task_id=$1", [
        t.id,
      ])
    ).rowCount,
    1,
  );
});
test("expired or revoked eligibility preserves participant history but denies new market activity", async () => {
  try {
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [owner],
    );
    const view = await market.agreement(owner, agreement.id);
    assert.equal(view.id, agreement.id);
    assert.equal((await market.getOrder(owner, order.id)).id, order.id);
    assert.ok((await market.agreements(owner)).length > 0);
    assert.ok((await market.orders(owner)).length > 0);
    assert.ok(
      (await market.submissions(owner, view.milestones[0].id)).length > 0,
    );
    assert.ok(
      (await market.messages(owner, { agreementId: agreement.id })).length > 0,
    );
    await assert.rejects(
      market.tasks(owner, {}),
      (e) => e.code === "membership_required",
    );
    await assert.rejects(
      market.publishTask(owner, taskBody, key()),
      (e) => e.code === "membership_required",
    );
    await assert.rejects(
      market.getOrder(stranger, order.id),
      (e) => e.code === "not_found",
    );
    await f.owner.query("UPDATE campus.domains SET enabled=false");
    assert.equal(
      (await market.agreement(owner, agreement.id)).id,
      agreement.id,
    );
    assert.equal((await market.getOrder(owner, order.id)).id, order.id);
    await f.owner.query(
      "UPDATE campus.users SET account_status='locked' WHERE id=$1",
      [owner],
    );
    await assert.rejects(
      market.getOrder(owner, order.id),
      (e) => e.code === "account_locked",
    );
  } finally {
    await f.owner.query("UPDATE campus.domains SET enabled=true");
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '1 year' WHERE user_id=$1",
      [owner],
    );
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [owner],
    );
  }
});
test("application and invitation commands recheck task state after acquiring the shared task lock", async () => {
  const t = await market.publishTask(owner, taskBody, key());
  const a = await market.apply(
    captain,
    t.id,
    { proposal: "Existing application", teamId: null },
    key(),
  );
  async function blockedCommand(command, table) {
    await f.owner.query("BEGIN");
    try {
      await f.owner.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["task:" + t.id],
      );
      await f.owner.query(`LOCK TABLE campus.${table} IN SHARE MODE`);
      const running = command().then(
        (v) => ({ value: v }),
        (error) => ({ error }),
      );
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const r = await f.owner.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_app' AND wait_event_type='Lock'",
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
        "command must reach the controlled database lock",
      );
      await f.owner.query(
        "UPDATE campus.tasks SET status='contracted' WHERE id=$1",
        [t.id],
      );
      await f.owner.query("COMMIT");
      const result = await running;
      assert.equal(result.error?.code, "invalid_state");
    } finally {
      await f.owner.query("ROLLBACK");
    }
  }
  await blockedCommand(
    () =>
      market.apply(
        student,
        t.id,
        { proposal: "Late application", teamId: null },
        key(),
      ),
    "applications",
  );
  await f.owner.query("UPDATE campus.tasks SET status='open' WHERE id=$1", [
    t.id,
  ]);
  await blockedCommand(
    () => market.inviteApplicant(owner, a.id, {}, key()),
    "applications",
  );
});
