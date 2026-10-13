import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { notificationQuery } from "../../backend/modules/notifications.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
import { connectionString } from "../../scripts/backend-local.mjs";
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const code = (c) => (e) => e.code === c;
const background = {
  purpose: "Local research",
  activities: "Compare sources",
  timeCommitment: "One hour",
  projectContext: "Private project background",
};
const rev = (t) => ({ expectedRevision: t.revision });
const people = async (count = 4) => {
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(await f.user(`Person ${i}`));
  return ids;
};
const taskBody = (count = 2) => ({
  title: "PRIVATE TASK TITLE",
  category: "Research",
  description: "PRIVATE RESEARCH",
  rewardCents: count * 100,
  milestones: Array.from({ length: count }, (_, i) => ({
    title: `Stage ${i}`,
    amountCents: 100,
    deliverable: "PRIVATE DELIVERABLE",
  })),
});
const inbox = (actor, query = {}) => market.notifications(actor, query);
const kinds = async (actor) =>
  (await inbox(actor, { limit: "50" })).items.map((n) => n.kind);
async function signed(count = 2) {
  const [owner, captain, outsider] = await people(3);
  const task = await market.publishTask(owner, taskBody(count), key());
  const application = await market.apply(
    captain,
    task.id,
    { proposal: "PRIVATE PROPOSAL" },
    key(),
  );
  await market.inviteApplicant(owner, application.id, {}, key());
  const agreement = await market.acceptInvitation(
    captain,
    application.id,
    {},
    key(),
  );
  return { owner, captain, outsider, task, application, agreement };
}
const submit = (m, content = "PRIVATE WORK") => ({
  content,
  expectedVersion: m.version,
  expectedRevision: m.revision,
});
const review = (r) => ({
  submissionId: r.submission.id,
  expectedVersion: r.milestone.version,
  expectedRevision: r.milestone.revision,
});

test("application snapshots, consent, decisions and signed work exclude unconfirmed/new team members and actors", async () => {
  const [owner, captain, peer, newcomer, outsider] = await people(5);
  let team = await market.createTeam(
    captain,
    { name: "PRIVATE TEAM", context: background },
    key(),
  );
  team = await market.inviteMember(
    captain,
    team.id,
    { ...rev(team), userId: peer },
    key(),
  );
  assert.deepEqual(await kinds(peer), ["team.invite"]);
  assert.deepEqual(await kinds(captain), []);
  team = await market.acceptMembership(peer, team.id, rev(team), key());
  const task = await market.publishTask(owner, taskBody(1), key());
  const body = { proposal: "PRIVATE PROPOSAL", teamId: team.id },
    once = key();
  const results = await Promise.all([
    market.apply(captain, task.id, body, once),
    market.apply(captain, task.id, body, once),
  ]);
  const app = results[0];
  assert.equal(app.id, results[1].id);
  assert.deepEqual(await kinds(owner), ["application.received"]);
  assert.equal(
    (await kinds(peer)).filter((x) => x === "application.consent_requested")
      .length,
    1,
  );
  await assert.rejects(
    market.inviteApplicant(owner, app.id, {}, key()),
    code("team_consent_required"),
  );
  assert.ok(!(await kinds(peer)).includes("application.invited"));
  await market.consentApplication(peer, app.id, {}, key());
  await market.consentApplication(peer, app.id, {}, key());
  assert.equal(
    (await kinds(captain)).filter((x) => x === "application.consented").length,
    1,
  );
  await market.inviteApplicant(owner, app.id, {}, key());
  const acceptKey = key();
  const agreement = await market.acceptInvitation(
    captain,
    app.id,
    {},
    acceptKey,
  );
  await market.acceptInvitation(captain, app.id, {}, acceptKey);
  assert.equal(
    (await kinds(owner)).filter((x) => x === "application.accepted").length,
    1,
  );
  assert.equal(
    (await kinds(peer)).filter((x) => x === "application.accepted").length,
    1,
  );
  assert.ok(!(await kinds(captain)).includes("application.accepted"));
  team = await market.inviteMember(
    captain,
    team.id,
    { ...rev(team), userId: newcomer },
    key(),
  );
  team = await market.acceptMembership(newcomer, team.id, rev(team), key());
  await market.sendMessage(
    owner,
    { agreementId: agreement.id, body: "PRIVATE MESSAGE" },
    key(),
  );
  assert.ok((await kinds(peer)).includes("message.received"));
  assert.ok(!(await kinds(newcomer)).includes("message.received"));
  assert.deepEqual(await kinds(outsider), []);
  const peerInbox = await inbox(peer);
  const dto = JSON.stringify({
    ...peerInbox,
    items: peerInbox.items.map(({ contextLabel, messageContext, ...n }) => n),
  });
  assert.equal(
    peerInbox.items.find((n) => n.kind === "message.received").contextLabel,
    "PRIVATE TASK TITLE",
  );
  assert.ok(
    peerInbox.items.every((n) => !n.target || !("contextLabel" in n.target)),
  );
  assert.equal(
    peerInbox.items.find((n) => n.kind === "message.received").messageContext
      .preview,
    "PRIVATE MESSAGE",
  );
  assert.ok(
    peerInbox.items.every(
      (n) => n.kind === "message.received" || n.messageContext === null,
    ),
  );
  for (const forbidden of [
    "PRIVATE TEAM",
    "PRIVATE MESSAGE",
    "PRIVATE PROPOSAL",
    "PRIVATE TASK TITLE",
    "PRIVATE RESEARCH",
  ])
    assert.ok(!dto.includes(forbidden));
  const stored = JSON.stringify(
    (
      await f.owner.query(
        "SELECT * FROM campus.notifications WHERE recipient_id=$1",
        [peer],
      )
    ).rows,
  );
  assert.ok(!stored.includes("PRIVATE"));
  const deniedTask = await market.task(outsider, task.id);
  assert.equal(deniedTask.related_agreement, null);
  assert.deepEqual((await market.task(peer, task.id)).related_agreement, {
    id: agreement.id,
    state: "awaiting_funding",
  });
  // Leaving the live team cannot rewrite signed membership or suppress work history.
  team = await market.removeMember(captain, team.id, peer, rev(team), key());
  await market.sendMessage(
    owner,
    { agreementId: agreement.id, body: "PRIVATE LATER MESSAGE" },
    key(),
  );
  assert.equal(
    (await kinds(peer)).filter((x) => x === "message.received").length,
    2,
  );
  assert.ok(
    (await inbox(peer)).items
      .filter((n) => n.kind === "message.received")
      .every((n) => n.targetAvailable),
  );
  const oldInvite = (await inbox(peer)).items.find(
    (n) => n.kind === "team.invite",
  );
  assert.equal(oldInvite.target, null);
  assert.equal(oldInvite.contextLabel, null);
  assert.equal(oldInvite.title, "Activity update");
});

test("application decline, withdrawal and supersession deliver once to actual parties", async () => {
  const [owner, a, b, c] = await people();
  const task = await market.publishTask(owner, taskBody(1), key());
  const first = await market.apply(a, task.id, { proposal: "a" }, key());
  await market.rejectApplication(owner, first.id, {}, key());
  await market.rejectApplication(owner, first.id, {}, key());
  assert.equal(
    (await kinds(a)).filter((x) => x === "application.declined").length,
    1,
  );
  const withdrawn = await market.apply(b, task.id, { proposal: "b" }, key());
  await market.withdrawApplication(b, withdrawn.id, {}, key());
  assert.equal(
    (await kinds(owner)).filter((x) => x === "application.withdrawn").length,
    1,
  );
  const other = await market.apply(a, task.id, { proposal: "again" }, key());
  const selected = await market.apply(
    c,
    task.id,
    { proposal: "selected" },
    key(),
  );
  await market.inviteApplicant(owner, selected.id, {}, key());
  await market.acceptInvitation(c, selected.id, {}, key());
  assert.equal(
    (await kinds(a)).filter((x) => x === "application.superseded").length,
    1,
  );
  assert.ok(
    (await inbox(a)).items.find((x) => x.kind === "application.superseded")
      .target.id === other.id,
  );
});

test("team context change, invitation cycles and captain transfer are event-scoped; no generic event or no-op notifications", async () => {
  const [captain, peer, invited] = await people(3);
  let t = await market.createTeam(
    captain,
    { name: "Team", context: background },
    key(),
  );
  t = await market.inviteMember(
    captain,
    t.id,
    { ...rev(t), userId: peer },
    key(),
  );
  t = await market.acceptMembership(peer, t.id, rev(t), key());
  t = await market.inviteMember(
    captain,
    t.id,
    { ...rev(t), userId: invited },
    key(),
  );
  const body = { ...rev(t), context: { ...background, purpose: "Changed" } },
    k = key();
  t = await market.updateTeamContext(captain, t.id, body, k);
  await market.updateTeamContext(captain, t.id, body, k);
  await market.updateTeamContext(
    captain,
    t.id,
    { ...rev(t), context: body.context },
    key(),
  );
  assert.equal(
    (await kinds(peer)).filter((x) => x === "team.context").length,
    1,
  );
  assert.equal(
    (await kinds(invited)).filter((x) => x === "team.context").length,
    1,
  );
  t = await market.revokeInvitation(captain, t.id, invited, rev(t), key());
  t = await market.inviteMember(
    captain,
    t.id,
    { ...rev(t), userId: invited },
    key(),
  );
  assert.equal(
    (await kinds(invited)).filter((x) => x === "team.invite").length,
    2,
  );
  t = await market.transferCaptain(
    captain,
    t.id,
    { ...rev(t), userId: peer },
    key(),
  );
  assert.ok((await kinds(peer)).includes("team.captain"));
  const before = (await inbox(peer)).unreadCount;
  await store.as(captain, (c) =>
    c.query(
      "INSERT INTO campus.events(kind,object_id) VALUES('team.context',$1)",
      [t.id],
    ),
  );
  assert.equal((await inbox(peer)).unreadCount, before);
});

test("milestone revision notifications, exact overview counts and completed task reference are atomic and deduplicated", async () => {
  const s = await signed(2);
  let counts = (await market.agreements(s.owner))[0].milestone_counts;
  assert.deepEqual(counts, {
    pending: 2,
    submitted: 0,
    revision_requested: 0,
    accepted: 0,
    total: 2,
  });
  const [a, b] = (await market.agreement(s.owner, s.agreement.id)).milestones;
  await assert.rejects(
    market.submitMilestone(s.captain, a.id, submit(a), key()),
    code("funding_required"),
  );
  assert.ok(!(await kinds(s.owner)).includes("milestone.submitted"));
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [s.agreement.id],
  );
  const k = key(),
    input = submit(a);
  const [r, replay] = await Promise.all([
    market.submitMilestone(s.captain, a.id, input, k),
    market.submitMilestone(s.captain, a.id, input, k),
  ]);
  assert.equal(r.receipt.submissionId, replay.receipt.submissionId);
  assert.equal(
    (await kinds(s.owner)).filter((x) => x === "milestone.submitted").length,
    1,
  );
  const changes = await market.requestMilestoneRevision(
    s.owner,
    a.id,
    { ...review(r), feedback: "PRIVATE FEEDBACK" },
    key(),
  );
  counts = (await market.agreements(s.captain))[0].milestone_counts;
  assert.deepEqual(counts, {
    pending: 1,
    submitted: 0,
    revision_requested: 1,
    accepted: 0,
    total: 2,
  });
  const r2 = await market.submitMilestone(
    s.captain,
    a.id,
    submit(changes.milestone),
    key(),
  );
  await market.acceptMilestone(s.owner, a.id, review(r2), key());
  const rb = await market.submitMilestone(s.captain, b.id, submit(b), key());
  const ak = key();
  await market.acceptMilestone(s.owner, b.id, review(rb), ak);
  await market.acceptMilestone(s.owner, b.id, review(rb), ak);
  assert.equal(
    (await kinds(s.captain)).filter((x) => x === "agreement.completed").length,
    1,
  );
  assert.equal(
    (await kinds(s.captain)).filter((x) => x === "milestone.accepted").length,
    2,
  );
  assert.deepEqual((await market.agreements(s.captain))[0].milestone_counts, {
    pending: 0,
    submitted: 0,
    revision_requested: 0,
    accepted: 2,
    total: 2,
  });
  const detail = await market.task(s.owner, s.task.id);
  assert.equal(detail.status, "contracted");
  assert.equal(detail.related_agreement.state, "completed");
  assert.deepEqual(await market.agreements(s.outsider), []);
  assert.ok(
    !JSON.stringify(await inbox(s.captain)).includes("PRIVATE FEEDBACK"),
  );
});

test("rollback removes notifications with business rows, replay/read is permission checked and read time immutable", async () => {
  const s = await signed(1);
  const initial = (await inbox(s.owner)).unreadCount;
  await assert.rejects(
    store.as(s.captain, async (c) => {
      await c.query(
        "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'rolled back')",
        [s.captain, s.agreement.id],
      );
      throw Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await inbox(s.owner)).unreadCount, initial);
  const n = (await inbox(s.owner)).items[0],
    k = key();
  await assert.rejects(
    market.readNotification(s.outsider, n.id, {}, k),
    code("not_found"),
  );
  await assert.rejects(
    market.readNotification(s.owner, key(), {}, key()),
    code("not_found"),
  );
  await assert.rejects(
    market.readNotification(s.owner, n.id, { readAt: "yesterday" }, key()),
    code("invalid_input"),
  );
  await assert.rejects(
    market.readNotification(s.owner, n.id, {}, "short"),
    code("idempotency_required"),
  );
  const [a, b] = await Promise.all([
    market.readNotification(s.owner, n.id, {}, k),
    market.readNotification(s.owner, n.id, {}, k),
  ]);
  assert.equal(a.readAt, b.readAt);
  assert.ok(a.readAt);
  assert.equal(
    (await market.readNotification(s.owner, n.id, {}, key())).readAt,
    a.readAt,
  );
  assert.equal(
    (await inbox(s.owner)).items.find((x) => x.id === n.id).readAt,
    a.readAt,
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [s.owner],
  );
  assert.ok((await inbox(s.owner)).items.length);
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [s.owner],
  );
  assert.equal(
    (await market.readNotification(s.owner, n.id, {}, k)).readAt,
    a.readAt,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [s.owner],
  );
  await assert.rejects(inbox(s.owner), code("account_locked"));
  await assert.rejects(
    market.readNotification(s.owner, n.id, {}, k),
    code("account_locked"),
  );
  assert.equal(
    (
      await store.as(s.owner, (c) =>
        c.query("SELECT * FROM campus.notifications"),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await store.as(s.owner, (c) =>
        c.query("SELECT campus.notification_target('agreement',$1) AS target", [
          s.agreement.id,
        ]),
      )
    ).rows[0].target,
    null,
  );
});

test("database role cannot forge notifications, mutate event fields, reset read status or call internal emitter", async () => {
  const s = await signed(1),
    n = (await inbox(s.owner)).items[0];
  for (const sql of [
    `INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id) VALUES('${s.owner}','forged','message.received','agreement','${s.agreement.id}')`,
    `UPDATE campus.notifications SET recipient_id='${s.captain}' WHERE id='${n.id}'`,
    `UPDATE campus.notifications SET read_at=now() WHERE id='${n.id}'`,
    `DELETE FROM campus.notifications WHERE id='${n.id}'`,
    `SELECT campus.emit_notification('forged','message.received','agreement','${s.agreement.id}',ARRAY['${s.owner}'::uuid],NULL)`,
  ])
    await assert.rejects(
      store.as(s.owner, (c) => c.query(sql)),
      code("42501"),
    );
  await assert.rejects(
    store.as(s.outsider, (c) =>
      c.query("SELECT campus.mark_notification_read($1)", [n.id]),
    ),
    code("P0001"),
  );
  await market.readNotification(s.owner, n.id, {}, key());
  await assert.rejects(
    f.owner.query("UPDATE campus.notifications SET read_at=NULL WHERE id=$1", [
      n.id,
    ]),
    code("23514"),
  );
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.notifications SET kind='message.received' WHERE id=$1",
      [n.id],
    ),
    code("23514"),
  );
  await assert.rejects(
    store.auth.query("SELECT * FROM campus.notifications"),
    code("42501"),
  );
  await assert.rejects(
    store.worker.query("SELECT campus.mark_notification_read($1)", [n.id]),
    code("42501"),
  );
});

test("keyset pagination preserves microseconds and old-page boundaries under inserts and read races", async () => {
  const s = await signed(1);
  for (let i = 0; i < 6; i++)
    await market.sendMessage(
      s.captain,
      { agreementId: s.agreement.id, body: `message ${i}` },
      key(),
    );
  const all = (await inbox(s.owner, { limit: "50" })).items;
  const first = await inbox(s.owner, { limit: "2", unread: "true" });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const cursor = JSON.parse(
    Buffer.from(first.nextCursor, "base64url").toString(),
  );
  assert.match(cursor.createdAt, /\.\d{6}Z$/);
  const selected = first.items[0],
    k = key();
  await Promise.all([
    market.readNotification(s.owner, selected.id, {}, k),
    market.sendMessage(
      s.captain,
      { agreementId: s.agreement.id, body: "insert between pages" },
      key(),
    ),
  ]);
  const seen = [...first.items];
  let next = first.nextCursor;
  while (next) {
    const p = await inbox(s.owner, {
      limit: "2",
      unread: "true",
      cursor: next,
    });
    seen.push(...p.items);
    next = p.nextCursor;
  }
  assert.deepEqual(
    seen.map((x) => x.id),
    all.map((x) => x.id),
  );
  assert.equal(new Set(seen.map((x) => x.id)).size, seen.length);
  const refreshed = await inbox(s.owner, { unread: "true", limit: "50" });
  assert.equal(refreshed.unreadCount, all.length);
  assert.ok(!refreshed.items.some((x) => x.id === selected.id));
  assert.ok(!seen.some((x) => x.id === refreshed.items[0].id));
  for (const input of [
    { limit: "0" },
    { limit: "51" },
    { limit: "1.0" },
    { limit: 2 },
    { limit: " 2" },
    { unread: "1" },
    { offset: "0" },
    { cursor: "bad" },
    { cursor: first.nextCursor },
    { cursor: "a".repeat(513) },
  ])
    assert.throws(() => notificationQuery(input), code("invalid_input"));
  const invalidDate = Buffer.from(
    JSON.stringify({ ...cursor, createdAt: "2026-02-31T00:00:00.000000Z" }),
  ).toString("base64url");
  assert.throws(
    () => notificationQuery({ unread: "true", cursor: invalidDate }),
    code("invalid_input"),
  );
});

test("order parties receive create/cancel/expiry/dispatch/receipt events with no address or message body", async () => {
  const [seller, buyer, other] = await people(3);
  const product = await market.publishProduct(
    seller,
    {
      title: "Private listing",
      description: "desc",
      priceCents: 100,
      stock: 5,
      deliveryMethods: ["pickup", "shipping"],
      shippingCents: 0,
    },
    key(),
  );
  async function reserve(method = "pickup") {
    const quote = await market.quote(
      buyer,
      product.id,
      { quantity: 1, deliveryMethod: method },
      key(),
    );
    return market.order(
      buyer,
      {
        quoteId: quote.id,
        ...(method === "shipping"
          ? {
              shippingAddress: {
                name: "PRIVATE BUYER",
                line1: "PRIVATE ADDRESS",
                city: "Test",
                region: "CA",
                postalCode: "00000",
                country: "US",
              },
            }
          : {}),
      },
      key(),
    );
  }
  const a = await reserve();
  assert.deepEqual(await kinds(seller), ["order.created"]);
  assert.deepEqual(await kinds(buyer), []);
  const ck = key();
  await market.cancelOrder(buyer, a.id, {}, ck);
  await market.cancelOrder(buyer, a.id, {}, ck);
  assert.equal(
    (await kinds(seller)).filter((x) => x === "order.cancelled").length,
    1,
  );
  const b = await reserve();
  await f.owner.query(
    "UPDATE campus.orders SET reserved_until=now()-interval '1 minute' WHERE id=$1",
    [b.id],
  );
  await market.expireReservations();
  await market.expireReservations();
  assert.equal(
    (await kinds(buyer)).filter((x) => x === "order.expired").length,
    1,
  );
  const c = await reserve("shipping");
  await f.owner.query("UPDATE campus.orders SET state='paid' WHERE id=$1", [
    c.id,
  ]);
  await market.fulfillOrder(
    seller,
    c.id,
    { carrier: "Carrier", trackingNumber: "PRIVATE TRACKING" },
    key(),
  );
  await market.sendMessage(
    seller,
    { orderId: c.id, body: "PRIVATE ORDER MESSAGE" },
    key(),
  );
  await market.completeOrder(buyer, c.id, {}, key());
  assert.ok((await kinds(buyer)).includes("order.shipped"));
  assert.ok((await kinds(seller)).includes("order.completed"));
  const d = await reserve();
  await f.owner.query("UPDATE campus.orders SET state='paid' WHERE id=$1", [
    d.id,
  ]);
  await market.fulfillOrder(seller, d.id, {}, key());
  assert.ok((await kinds(buyer)).includes("order.ready_for_pickup"));
  const buyerInbox = await inbox(buyer);
  assert.ok(
    !JSON.stringify({
      ...buyerInbox,
      items: buyerInbox.items.map(({ messageContext, ...n }) => n),
    }).includes("PRIVATE"),
  );
  assert.equal(
    buyerInbox.items.find((n) => n.kind === "message.received").messageContext
      .preview,
    "PRIVATE ORDER MESSAGE",
  );
  assert.equal(
    (await inbox(buyer)).items.find((n) => n.kind === "order.shipped")
      .contextLabel,
    "Private listing",
  );
  assert.deepEqual(await kinds(other), []);
});

test("own eligibility outcome only, with no reviewer reason copied into the notification", async () => {
  const [reviewer, applicant, other] = await people(3);
  await f.owner.query(
    "UPDATE campus.affiliations SET can_apply=false WHERE user_id=$1",
    [applicant],
  );
  await f.owner.query(
    "INSERT INTO campus.eligibility_reviewers VALUES($1,$2)",
    [reviewer, f.institution],
  );
  const id = (
    await store.as(applicant, (c) =>
      c.query(
        "SELECT campus.request_student_eligibility('PRIVATE ENROLLMENT',true) AS id",
      ),
    )
  ).rows[0].id;
  const decide = () =>
    store.as(reviewer, (c) =>
      c.query(
        "SELECT campus.decide_student_eligibility($1,'rejected','PRIVATE REVIEW REASON',NULL)",
        [id],
      ),
    );
  await decide();
  await decide();
  const items = (await inbox(applicant)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "eligibility.rejected");
  assert.equal(items[0].target.id, id);
  assert.equal(items[0].contextLabel, null);
  assert.ok(!JSON.stringify(items).includes("PRIVATE"));
  assert.deepEqual(await kinds(reviewer), []);
  assert.deepEqual(await kinds(other), []);
});

test("cursor uses exact microseconds and deterministic UUID ordering for timestamp ties", async () => {
  const s = await signed(1);
  const sameMillisecond = [
    "2099-01-01T00:00:00.123001Z",
    "2099-01-01T00:00:00.123002Z",
    "2099-01-01T00:00:00.123002Z",
  ];
  const ids = [];
  for (const time of sameMillisecond) {
    const id = key();
    ids.push(id);
    await f.owner.query(
      "INSERT INTO campus.notifications(id,recipient_id,event_key,kind,target_type,target_id,created_at) VALUES($1,$2,$3,'message.received','agreement',$4,$5)",
      [id, s.owner, `fixture:${id}`, s.agreement.id, time],
    );
  }
  const all = (await inbox(s.owner, { limit: "50" })).items;
  const first = await inbox(s.owner, { limit: "1" });
  const second = await inbox(s.owner, { limit: "1", cursor: first.nextCursor });
  const third = await inbox(s.owner, { limit: "1", cursor: second.nextCursor });
  assert.deepEqual(
    [first.items[0].id, second.items[0].id, third.items[0].id],
    all.slice(0, 3).map((x) => x.id),
  );
  assert.deepEqual(
    [first.items[0].id, second.items[0].id],
    [ids[1], ids[2]].sort().reverse(),
  );
  assert.equal(third.items[0].createdAt, "2099-01-01T00:00:00.123001Z");
  const bad = Buffer.from(
    JSON.stringify({
      createdAt: "0000-01-01T00:00:00.000000Z",
      id: key(),
      unread: false,
    }),
  ).toString("base64url");
  assert.throws(
    () => notificationQuery({ cursor: bad }),
    code("invalid_input"),
  );
});

test("context labels are read from current authorized targets, kept out of storage and cleared on revoked access", async () => {
  const s = await signed(1);
  let t = await market.createTeam(
    s.owner,
    { name: "Visible team label", context: background },
    key(),
  );
  t = await market.inviteMember(
    s.owner,
    t.id,
    { ...rev(t), userId: s.captain },
    key(),
  );
  const invitation = (await inbox(s.captain)).items.find(
    (n) => n.kind === "team.invite",
  );
  assert.equal(invitation.contextLabel, "Visible team label");
  assert.deepEqual(invitation.target, { type: "team", id: t.id });
  const once = key();
  assert.equal(
    (await market.readNotification(s.captain, invitation.id, {}, once))
      .contextLabel,
    "Visible team label",
  );
  await market.revokeInvitation(s.owner, t.id, s.captain, rev(t), key());
  const replay = await market.readNotification(
    s.captain,
    invitation.id,
    {},
    once,
  );
  assert.equal(replay.contextLabel, null);
  assert.equal(replay.target, null);
  const application = (await inbox(s.captain)).items.find(
    (n) => n.kind === "application.invited",
  );
  assert.equal(application.contextLabel, "PRIVATE TASK TITLE");
  await market.sendMessage(
    s.owner,
    { agreementId: s.agreement.id, body: "PRIVATE MESSAGE" },
    key(),
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [s.captain],
  );
  const expired = await inbox(s.captain);
  const oldApplication = expired.items.find((n) => n.id === application.id);
  assert.equal(oldApplication.contextLabel, null);
  assert.deepEqual(oldApplication.target, {
    type: "application",
    id: s.application.id,
  });
  assert.equal(
    expired.items.find((n) => n.kind === "message.received").contextLabel,
    "PRIVATE TASK TITLE",
  );
  const stored = JSON.stringify(
    (
      await f.owner.query(
        "SELECT * FROM campus.notifications WHERE recipient_id=$1",
        [s.captain],
      )
    ).rows,
  );
  assert.ok(!stored.includes("Visible team label"));
  assert.ok(!stored.includes("PRIVATE"));
});

test("010 forward upgrade preserves every existing table row and never backfills old events", async () => {
  const database = "campus_test_" + key().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(f.config, "migrator"),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const owner = new pg.Client({
    connectionString: connectionString(f.config, "migrator", database),
  });
  await owner.connect();
  try {
    const dir = new URL("../../backend/db/migrations/", import.meta.url),
      names = (await readdir(dir)).filter((n) => /^\d.*\.sql$/.test(n)).sort();
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of names.filter((n) => n < "011")) {
      const sql = await readFile(new URL(name, dir), "utf8");
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const user = key();
    await owner.query(
      "INSERT INTO campus.users(id,display_name) VALUES($1,'Legacy user')",
      [user],
    );
    await owner.query(
      "INSERT INTO campus.events(kind,object_id) VALUES('message.send',$1)",
      [key()],
    );
    const captain = key(),
      task = key(),
      app = key(),
      agreement = key();
    await owner.query(
      "INSERT INTO campus.users(id,display_name) VALUES($1,'Legacy captain')",
      [captain],
    );
    await owner.query(
      "INSERT INTO campus.tasks(id,owner_id,title,category,description,reward_cents,status) VALUES($1,$2,'Legacy task','Research','Frozen research',100,'contracted')",
      [task, user],
    );
    await owner.query(
      "INSERT INTO campus.applications(id,task_id,applicant_id,proposal,state) VALUES($1,$2,$3,'Frozen proposal','accepted')",
      [app, task, captain],
    );
    await owner.query(
      'INSERT INTO campus.agreements(id,task_id,application_id,owner_id,captain_id,terms) VALUES($1,$2,$3,$4,$5,\'{"taskTitle":"Legacy task"}\')',
      [agreement, task, app, user, captain],
    );
    await owner.query("INSERT INTO campus.agreement_members VALUES($1,$2)", [
      agreement,
      captain,
    ]);
    await owner.query(
      "INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable) VALUES($1,1,'Legacy phase',100,'Frozen terms')",
      [agreement],
    );
    await owner.query(
      "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'Existing private conversation')",
      [captain, agreement],
    );
    const tables = (
      await owner.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='campus' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);
    async function snapshots() {
      const result = {};
      for (const t of tables)
        result[t] = (
          await owner.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM campus.${t} t`,
          )
        ).rows[0].rows;
      return result;
    }
    const before = await snapshots();
    assert.equal(await migrate(owner), names.filter((n) => n >= "011").length);
    assert.equal(await migrate(owner), 0);
    const after = await snapshots();
    delete before.schema_migrations;
    delete after.schema_migrations;
    // 014 adds one nullable scope column. Retain every historical JSON field
    // and its value; independently require the additive field to be SQL null.
    for (const message of after.messages) {
      assert.equal(message.application_id, null);
      delete message.application_id;
    }
    assert.deepEqual(after, before);
    assert.equal(
      (await owner.query("SELECT count(*)::int AS n FROM campus.notifications"))
        .rows[0].n,
      0,
    );
  } finally {
    await owner.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
