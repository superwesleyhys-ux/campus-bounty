import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import {
  conversationQuery,
  conversationHttpQuery,
} from "../../backend/modules/conversations.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
import reviewedUpgrade from "../conversation-reviewed-upgrade.cjs";
import path from "node:path";
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
  projectContext: "",
};
const rev = (t) => ({ expectedRevision: t.revision });
const taskBody = (count = 2) => ({
  title: "Synthetic agreement",
  category: "Research",
  description: "Synthetic",
  rewardCents: 100 * count,
  milestones: Array.from({ length: count }, (_, i) => ({
    title: `Stage ${i + 1}`,
    amountCents: 100,
    deliverable: "Evidence",
  })),
});
async function signed(teamMode = false) {
  const owner = await f.user("Publisher"),
    captain = await f.user("Captain"),
    peer = await f.user("Peer"),
    outsider = await f.user("Outsider");
  let team;
  if (teamMode) {
    team = await market.createTeam(
      captain,
      { name: "Synthetic team", context: background },
      key(),
    );
    team = await market.inviteMember(
      captain,
      team.id,
      { ...rev(team), userId: peer },
      key(),
    );
    team = await market.acceptMembership(peer, team.id, rev(team), key());
  }
  const task = await market.publishTask(owner, taskBody(), key());
  const application = await market.apply(
    captain,
    task.id,
    { proposal: "Plan", ...(team ? { teamId: team.id } : {}) },
    key(),
  );
  if (team) await market.consentApplication(peer, application.id, {}, key());
  await market.inviteApplicant(owner, application.id, {}, key());
  const agreement = await market.acceptInvitation(
    captain,
    application.id,
    {},
    key(),
  );
  return { owner, captain, peer, outsider, team, agreement };
}
async function ordered() {
  const seller = await f.user("Seller"),
    buyer = await f.user("Buyer"),
    outsider = await f.user("Other");
  const product = await market.publishProduct(
    seller,
    {
      title: "Listing",
      description: "Synthetic",
      priceCents: 100,
      stock: 2,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const quote = await market.quote(
    buyer,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order = await market.order(buyer, { quoteId: quote.id }, key());
  return { seller, buyer, outsider, order };
}
const read = (actor, id, input = {}) =>
  market.conversation(actor, { agreementId: id, ...input });
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

test("empty agreement and order reads authorize scope; scoped current labels and frozen departed roster", async () => {
  const s = await signed(true);
  let page = await read(s.peer, s.agreement.id);
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
  assert.equal(page.limit, 30);
  assert.equal(page.participantCount, 3);
  assert.deepEqual(page.participants.map((p) => p.role).sort(), [
    "captain",
    "participant",
    "publisher",
  ]);
  for (const person of page.participants)
    assert.deepEqual(Object.keys(person).sort(), ["displayName", "id", "role"]);
  await assert.rejects(read(s.outsider, s.agreement.id), code("not_found"));
  s.team = await market.leaveTeam(s.peer, s.team.id, rev(s.team), key());
  s.team = await market.inviteMember(
    s.captain,
    s.team.id,
    { ...rev(s.team), userId: s.outsider },
    key(),
  );
  await market.acceptMembership(s.outsider, s.team.id, rev(s.team), key());
  await market.sendMessage(
    s.peer,
    { agreementId: s.agreement.id, body: "Signed history" },
    key(),
  );
  await store.as(s.peer, (c) =>
    c.query("UPDATE campus.users SET display_name='Renamed peer' WHERE id=$1", [
      s.peer,
    ]),
  );
  page = await read(s.peer, s.agreement.id);
  assert.equal(
    page.participants.find((p) => p.id === s.peer).displayName,
    "Renamed peer",
  );
  assert.equal(page.items[0].author.displayName, "Renamed peer");
  assert.ok(!page.participants.some((p) => p.id === s.outsider));
  await assert.rejects(read(s.outsider, s.agreement.id), code("not_found"));
  for (const state of ["restricted", "active"]) {
    await f.owner.query(
      "UPDATE campus.users SET account_status=$2 WHERE id=$1",
      [s.peer, state],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [s.peer],
    );
    assert.equal((await read(s.peer, s.agreement.id)).items.length, 1);
  }
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [s.peer],
  );
  await assert.rejects(read(s.peer, s.agreement.id), code("account_locked"));
  assert.equal(
    (
      await store.as(s.peer, (c) =>
        c.query("SELECT * FROM campus.conversation_people('agreement',$1)", [
          s.agreement.id,
        ]),
      )
    ).rows.length,
    0,
  );
  const o = await ordered();
  const op = await market.conversation(o.buyer, { orderId: o.order.id });
  assert.deepEqual(op.items, []);
  assert.deepEqual(op.participants.map((p) => p.role).sort(), [
    "buyer",
    "seller",
  ]);
  await assert.rejects(
    market.conversation(o.outsider, { orderId: o.order.id }),
    code("not_found"),
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [o.buyer],
  );
  assert.equal(
    (await market.conversation(o.buyer, { orderId: o.order.id }))
      .participantCount,
    2,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [o.buyer],
  );
  assert.equal(
    (await market.conversation(o.buyer, { orderId: o.order.id }))
      .participantCount,
    2,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [o.buyer],
  );
  await assert.rejects(
    market.conversation(o.buyer, { orderId: o.order.id }),
    code("account_locked"),
  );
  assert.equal(
    (
      await store.as(o.buyer, (c) =>
        c.query("SELECT * FROM campus.conversation_people('order',$1)", [
          o.order.id,
        ]),
      )
    ).rows.length,
    0,
  );
});

test("all 137 messages paginate with exact microseconds/ties/new arrivals; legacy array is unchanged", async () => {
  for (const type of ["agreement", "order"]) {
    const s = type === "agreement" ? await signed() : await ordered();
    const id = type === "agreement" ? s.agreement.id : s.order.id,
      actor = s.captain || s.buyer;
    const field = type === "agreement" ? "agreement_id" : "order_id",
      query = { [`${type}Id`]: id };
    await store.as(actor, (c) =>
      c.query(
        `INSERT INTO campus.messages(sender_id,${field},body,created_at)
   SELECT $1,$2,'message '||n,'2026-01-01T00:00:00.123001Z'::timestamptz+(n/3)*interval '1 microsecond' FROM generate_series(1,137)n`,
        [actor, id],
      ),
    );
    const expected = (
      await f.owner.query(
        `SELECT id,body,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM campus.messages WHERE ${field}=$1 ORDER BY created_at DESC,id DESC`,
        [id],
      )
    ).rows;
    const before = (
      await f.owner.query("SELECT count(*)::int AS n FROM campus.notifications")
    ).rows[0].n;
    let page = await market.conversation(actor, { ...query, limit: "17" }),
      seen = [...page.items];
    const cursor = page.nextCursor;
    await market.sendMessage(actor, { ...query, body: "New arrival" }, key());
    while (page.nextCursor) {
      page = await market.conversation(actor, {
        ...query,
        limit: "17",
        cursor: page.nextCursor,
      });
      seen.push(...page.items);
    }
    assert.deepEqual(
      seen.map(({ id, body, createdAt }) => ({ id, body, createdAt })),
      expected,
    );
    assert.equal(new Set(seen.map((m) => m.id)).size, 137);
    assert.equal(
      (await market.conversation(actor, query)).items[0].body,
      "New arrival",
    );
    const old = await market.messages(actor, query);
    assert.equal(old.length, 100);
    assert.equal(old[0].body, "New arrival");
    assert.ok(old.every((m) => !("author" in m)));
    assert.ok(seen.every((m) => /\.\d{6}Z$/.test(m.createdAt)));
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int AS n FROM campus.notifications",
        )
      ).rows[0].n,
      before + 1,
    );
    const decoded = JSON.parse(Buffer.from(cursor, "base64url"));
    for (const change of [
      { scopeId: key() },
      { id: key() },
      { createdAt: "2026-01-01T00:00:00.123000Z" },
    ]) {
      const bad = Buffer.from(
        JSON.stringify({ ...decoded, ...change }),
      ).toString("base64url");
      await assert.rejects(
        market.conversation(actor, { ...query, cursor: bad }),
        code("invalid_input"),
      );
    }
    await assert.rejects(
      market.conversation(s.outsider, { ...query, cursor }),
      code("not_found"),
    );
  }
});

test("participant roster beyond 100 is fully paginated and cursor-bound without user lookup", async () => {
  const s = await signed();
  await f.owner.query(
    `WITH people AS (INSERT INTO campus.users(display_name) SELECT 'Roster '||n FROM generate_series(1,112)n RETURNING id)
 INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT $1,id FROM people`,
    [s.agreement.id],
  );
  const first = await read(s.owner, s.agreement.id);
  assert.equal(first.participants.length, 100);
  assert.equal(first.participantCount, 114);
  assert.ok(first.nextParticipantCursor);
  const rest = await market.conversationParticipants(s.owner, {
    agreementId: s.agreement.id,
    cursor: first.nextParticipantCursor,
  });
  assert.equal(rest.items.length, 14);
  assert.equal(rest.nextCursor, null);
  assert.equal(
    new Set([...first.participants, ...rest.items].map((p) => p.id)).size,
    114,
  );
  const other = await signed();
  await assert.rejects(
    market.conversationParticipants(other.owner, {
      agreementId: other.agreement.id,
      cursor: first.nextParticipantCursor,
    }),
    code("invalid_input"),
  );
  await assert.rejects(
    read(s.owner, s.agreement.id, { cursor: first.nextParticipantCursor }),
    code("invalid_input"),
  );
  const decoded = JSON.parse(
    Buffer.from(first.nextParticipantCursor, "base64url"),
  );
  await assert.rejects(
    market.conversationParticipants(s.owner, {
      agreementId: s.agreement.id,
      cursor: Buffer.from(JSON.stringify({ ...decoded, id: key() })).toString(
        "base64url",
      ),
    }),
    code("invalid_input"),
  );
  assert.equal(
    (
      await store.as(s.outsider, (c) =>
        c.query("SELECT * FROM campus.conversation_people('agreement',$1)", [
          s.agreement.id,
        ]),
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await store.as(s.owner, (c) =>
        c.query("SELECT * FROM campus.conversation_people('users',$1)", [
          s.outsider,
        ]),
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await store.as(s.owner, (c) =>
        c.query("SELECT id FROM campus.users WHERE id=$1", [s.outsider]),
      )
    ).rows.length,
    0,
  );
});

test("strict limits, scopes, cursor schema, duplicate query and HTTP error contract", async () => {
  const s = await signed();
  const query = { agreementId: s.agreement.id };
  for (const bad of [
    {},
    { ...query, orderId: key() },
    { agreementId: "bad" },
    { ...query, limit: "0" },
    { ...query, limit: "51" },
    { ...query, limit: 1 },
    { ...query, limit: "01" },
    { ...query, limit: "1.0" },
    { ...query, offset: "1" },
    { ...query, cursor: "" },
    { ...query, cursor: "bad" },
    { ...query, cursor: "a".repeat(513) },
  ])
    assert.throws(() => conversationQuery(bad), code("invalid_input"));
  for (const createdAt of [
    "2026-02-31T00:00:00.000000Z",
    "0000-01-01T00:00:00.000000Z",
  ])
    assert.throws(
      () =>
        conversationQuery({
          ...query,
          cursor: Buffer.from(
            JSON.stringify({
              type: "agreement",
              scopeId: s.agreement.id,
              kind: "messages",
              id: key(),
              createdAt,
            }),
          ).toString("base64url"),
        }),
      code("invalid_input"),
    );
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "session" },
    auth: { resolve: async () => ({ id: s.owner }) },
  };
  const handler = endpoint(
    async () => runtime,
    { method: "GET" },
    ({ actor, request }) =>
      market.conversation(actor, conversationHttpQuery(request)),
  );
  for (const suffix of [
    "&agreementId=" + s.agreement.id,
    "&limit=30&limit=30",
    "&unexpected=1",
  ]) {
    const response = await handler(
      new Request(
        `http://127.0.0.1:3020/api/v1/conversations?agreementId=${s.agreement.id}${suffix}`,
        { headers: { host: "127.0.0.1:3020" } },
      ),
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "invalid_input");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("same-key send replay checks current permission before returning content and creates one notification", async () => {
  for (const type of ["agreement", "order"]) {
    const s = type === "agreement" ? await signed(true) : await ordered();
    const actor = s.peer || s.buyer,
      id = s.agreement?.id || s.order.id,
      input = { [`${type}Id`]: id, body: "PRIVATE CACHED MESSAGE" },
      once = key();
    const both = await Promise.all([
      market.sendMessage(actor, input, once),
      market.sendMessage(actor, input, once),
    ]);
    assert.deepEqual(both[0], both[1]);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.messages WHERE id=$1",
          [both[0].id],
        )
      ).rows[0].n,
      1,
    );
    const recipients = type === "agreement" ? 2 : 1;
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.notifications WHERE event_key=$1",
          ["message:" + both[0].id],
        )
      ).rows[0].n,
      recipients,
    );
    await assert.rejects(
      market.sendMessage(actor, { ...input, body: "changed" }, once),
      code("idempotency_conflict"),
    );
    for (const state of ["restricted", "locked"]) {
      await f.owner.query(
        "UPDATE campus.users SET account_status=$2 WHERE id=$1",
        [actor, state],
      );
      await assert.rejects(
        market.sendMessage(actor, input, once),
        (e) => e.status === 403 && !e.message.includes("PRIVATE"),
      );
    }
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [actor],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [actor],
    );
    await assert.rejects(
      market.sendMessage(actor, input, once),
      code("membership_required"),
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '1 day' WHERE user_id=$1",
      [actor],
    );
    await f.owner.query(
      "UPDATE campus.domains SET enabled=false WHERE domain=$1",
      ["campus.example.test"],
    );
    await assert.rejects(
      market.sendMessage(actor, input, once),
      code("membership_required"),
    );
    await f.owner.query(
      "UPDATE campus.domains SET enabled=true WHERE domain=$1",
      ["campus.example.test"],
    );
    if (type === "agreement") {
      await f.owner.query(
        "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
        [id, actor],
      );
      await assert.rejects(
        market.sendMessage(actor, input, once),
        code("not_found"),
      );
    }
  }
});

test("new exact milestone notifications remain distinct across versions/stages/reviews; immutable and authorized", async () => {
  const s = await signed(true);
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [s.agreement.id],
  );
  const [m, n] = (await market.agreement(s.owner, s.agreement.id)).milestones;
  const once = key(),
    input = submit(m),
    first = await market.submitMilestone(s.captain, m.id, input, once);
  await market.submitMilestone(s.captain, m.id, input, once);
  const requested = await market.requestMilestoneRevision(
    s.owner,
    m.id,
    { ...review(first), feedback: "PRIVATE FEEDBACK" },
    key(),
  );
  const second = await market.submitMilestone(
    s.peer,
    m.id,
    submit(requested.milestone),
    key(),
  );
  await market.acceptMilestone(s.owner, m.id, review(second), key());
  const last = await market.submitMilestone(s.captain, n.id, submit(n), key());
  await market.acceptMilestone(s.owner, n.id, review(last), key());
  const all = (
    await market.notifications(s.peer, { limit: "50" })
  ).items.filter((x) => x.kind.startsWith("milestone."));
  const firstNotice = all.find(
    (x) =>
      x.kind === "milestone.submitted" &&
      x.workContext.submissionId === first.submission.id,
  );
  assert.equal(firstNotice.workContext.submissionVersion, 1);
  assert.equal(firstNotice.workContext.milestoneRevision, 2);
  assert.equal(firstNotice.workContext.milestoneTitle, "Stage 1");
  assert.equal(firstNotice.workContext.reviewId, null);
  assert.deepEqual(firstNotice.navigationAnchor, {
    type: "milestone",
    milestoneId: m.id,
    submissionId: first.submission.id,
    reviewId: null,
  });
  const r = all.find((x) => x.kind === "milestone.revision_requested");
  assert.equal(r.workContext.submissionId, first.submission.id);
  assert.equal(r.workContext.submissionVersion, 1);
  assert.equal(r.workContext.milestoneRevision, 3);
  assert.equal(r.workContext.reviewId, requested.receipt.reviewId);
  assert.ok(
    all.some(
      (x) =>
        x.kind === "milestone.accepted" &&
        x.workContext.submissionVersion === 2 &&
        x.workContext.milestoneId === m.id,
    ),
  );
  assert.ok(
    all.some(
      (x) =>
        x.workContext.milestoneTitle === "Stage 2" &&
        x.workContext.submissionVersion === 1,
    ),
  );
  assert.ok(!JSON.stringify(all).includes("PRIVATE"));
  assert.equal(all.filter((x) => x.id === firstNotice.id).length, 1);
  const before = (
    await f.owner.query("SELECT count(*)::int n FROM campus.notifications")
  ).rows[0].n;
  await f.owner.query(
    "UPDATE campus.milestones SET revision=revision WHERE id=$1",
    [m.id],
  );
  assert.equal(
    (await f.owner.query("SELECT count(*)::int n FROM campus.notifications"))
      .rows[0].n,
    before,
  );
  const readKey = key();
  await market.readNotification(s.peer, firstNotice.id, {}, readKey);
  await f.owner.query(
    "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
    [s.agreement.id, s.peer],
  );
  const redacted = await market.readNotification(
    s.peer,
    firstNotice.id,
    {},
    readKey,
  );
  assert.equal(redacted.target, null);
  assert.equal(redacted.contextLabel, null);
  assert.equal(redacted.workContext, null);
  assert.equal(redacted.navigationAnchor, null);
  assert.equal(
    (
      await store.as(s.peer, (c) =>
        c.query(
          "SELECT * FROM campus.notification_work_context WHERE notification_id=$1",
          [firstNotice.id],
        ),
      )
    ).rows.length,
    0,
  );
  for (const sql of [
    "INSERT INTO campus.notification_work_context SELECT * FROM campus.notification_work_context",
    "UPDATE campus.notification_work_context SET submission_version=2",
    "DELETE FROM campus.notification_work_context",
    "SELECT campus.emit_notification('fake','milestone.submitted','agreement',$1,ARRAY[$2]::uuid[],$3)",
  ])
    await assert.rejects(
      store.as(s.owner, (c) =>
        c.query(
          sql,
          sql.includes("$1") ? [s.agreement.id, s.peer, s.owner] : undefined,
        ),
      ),
      code("42501"),
    );
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.notification_work_context SET submission_version=submission_version",
    ),
    code("23514"),
  );
  await assert.rejects(
    f.owner.query("DELETE FROM campus.notification_work_context"),
    code("23514"),
  );
  for (const role of ["auth", "worker"])
    for (const sql of [
      "SELECT * FROM campus.conversation_people('agreement',$1)",
      "SELECT campus.notification_work_detail($1)",
      "SELECT * FROM campus.notification_work_context WHERE notification_id=$1",
    ])
      await assert.rejects(
        store[role].query(sql, [s.agreement.id]),
        code("42501"),
      );
});

test("rolled back work creates neither notification nor metadata; unauthorized direct milestone writes fail", async () => {
  const s = await signed();
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [s.agreement.id],
  );
  const m = (await market.agreement(s.owner, s.agreement.id)).milestones[0];
  const count = async () =>
    (
      await f.owner.query(
        "SELECT (SELECT count(*) FROM campus.notifications)::int AS notifications,(SELECT count(*) FROM campus.notification_work_context)::int AS contexts",
      )
    ).rows[0];
  const before = await count();
  await assert.rejects(
    store.as(s.captain, async (c) => {
      await c.query("SELECT campus.submit_milestone_work($1,0,1,$2)", [
        m.id,
        "Rollback only",
      ]);
      throw new Error("rollback sentinel");
    }),
    /rollback sentinel/,
  );
  assert.deepEqual(await count(), before);
  await assert.rejects(
    store.as(s.captain, (c) =>
      c.query(
        "UPDATE campus.milestones SET state='submitted',revision=revision+1 WHERE id=$1",
        [m.id],
      ),
    ),
    code("42501"),
  );
  assert.deepEqual(await count(), before);
});

test("real 011 to 013 forward migration preserves every old row and old notification, no invented context; replay is zero", async () => {
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
  let legacyStore;
  try {
    const dir = new URL("../../backend/db/migrations/", import.meta.url),
      names = (await readdir(dir)).filter((n) => /^\d.*\.sql$/.test(n)).sort();
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of names.filter((n) => n < "012")) {
      const sql = await readFile(new URL(name, dir), "utf8");
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const institution = key(),
      publisher = key(),
      captain = key();
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'Legacy university',true,'Synthetic');",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('legacy.example.test',$1,true)",
      [institution],
    );
    for (const id of [publisher, captain]) {
      await owner.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,'Legacy label')",
        [id],
      );
      await owner.query(
        "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'legacy.example.test',now()+interval '1 year',true)",
        [id, institution],
      );
    }
    legacyStore = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((role) => [
          role,
          connectionString(f.config, role, database),
        ]),
      ),
    );
    const lm = createMarket(legacyStore),
      task = await lm.publishTask(publisher, taskBody(1), key());
    const app = await lm.apply(
      captain,
      task.id,
      { proposal: "Legacy plan" },
      key(),
    );
    await lm.inviteApplicant(publisher, app.id, {}, key());
    const a = await lm.acceptInvitation(captain, app.id, {}, key());
    await owner.query(
      "UPDATE campus.agreements SET state='active' WHERE id=$1",
      [a.id],
    );
    const m = (await lm.agreement(publisher, a.id)).milestones[0];
    // 011 has no new message gate; simulate the original SQL mutation under app RLS.
    await legacyStore.as(captain, (c) =>
      c.query(
        "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,$3)",
        [captain, a.id, "Legacy unchanged message"],
      ),
    );
    const work = await lm.submitMilestone(
      captain,
      m.id,
      submit(m, "Legacy work"),
      key(),
    );
    await lm.requestMilestoneRevision(
      publisher,
      m.id,
      { ...review(work), feedback: "Legacy feedback" },
      key(),
    );
    await owner.query(
      "UPDATE campus.notifications SET read_at=created_at WHERE kind=$1",
      ["milestone.submitted"],
    );
    const tables = (
      await owner.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='campus' AND tablename<>'schema_migrations' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);
    const snapshot = async () => {
      const result = {};
      for (const name of tables)
        result[name] = (
          await owner.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM campus.${name} t`,
          )
        ).rows[0].rows;
      return result;
    };
    const before = await snapshot();
    const expectedForward = [
      {
        name: "012_conversation_history_context.sql",
        checksum:
          "05ce34dd5067ae44bf6e1f15cc995f8184ddbe6e352228c554fb919bdf837d26",
      },
      {
        name: "013_message_scope_revalidation.sql",
        checksum:
          "ed5d08606e7dd93d588cba87993dbd5f7f9c556649da7f9e60b39d1414405190",
      },
    ];
    assert.deepEqual(
      names.filter((n) => n >= "012"),
      [...expectedForward.map((row) => row.name), reviewedUpgrade.migration014Name],
    );
    for (const row of expectedForward)
      assert.equal(
        createHash("sha256")
          .update(await readFile(new URL(row.name, dir)))
          .digest("hex"),
        row.checksum,
      );
    // This is still the historical 011→013 test. The reviewed helpers recognize
    // the pinned 014 file inventory, but never apply it to this historical target.
    let applied = 0;
    for (const [index, row] of expectedForward.entries()) {
      const outcome = await reviewedUpgrade[index === 0 ? "upgradeReviewed012" : "upgradeReviewed013"](owner, {
        expectedHash: row.checksum, migration: row.name,
        evidenceDirectory: path.resolve(".superpowers/sdd/interaction-round10-plan/task-2-evidence/legacy-context", key(), row.name),
      });
      applied += outcome.applied;
    }
    assert.equal(applied, 2);
    assert.deepEqual(
      (
        await owner.query(
          "SELECT name,checksum FROM campus.schema_migrations WHERE name >= '012' ORDER BY name",
        )
      ).rows,
      expectedForward,
    );
    assert.equal(await reviewedUpgrade.verifyReviewedReplay013(owner, {
      expectedHash: reviewedUpgrade.migration013Sha,
      migration: reviewedUpgrade.migration013Name,
    }), 0);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM campus.notification_work_context",
        )
      ).rows[0].n,
      0,
    );
    // Historical 011→013 receipt/count/replay and all original data checks above
    // are complete. Current service SQL requires 014; validate that separate
    // additive stage before retaining every original service-level assertion.
    const currentStage = await reviewedUpgrade.upgradeReviewed014(owner, {
      expectedHash: reviewedUpgrade.migration014Sha,
      migration: reviewedUpgrade.migration014Name,
      evidenceDirectory: path.resolve(".superpowers/sdd/interaction-round10-plan/task-2-evidence/legacy-context-current-service", key()),
    });
    assert.equal(currentStage.applied, 1);
    assert.equal(currentStage.historicalApplicationIdsNull, true);
    assert.deepEqual(currentStage.after, currentStage.before);
    assert.equal(currentStage.exactContexts, 0);
    assert.equal(await reviewedUpgrade.verifyReviewedReplay014(owner, {
      expectedHash: reviewedUpgrade.migration014Sha,
      migration: reviewedUpgrade.migration014Name,
    }), 0);
    const afterCurrentStage = await snapshot();
    for (const message of afterCurrentStage.messages) {
      assert.equal(message.application_id, null);
      delete message.application_id;
    }
    assert.deepEqual(afterCurrentStage, before);
    const historical = (await lm.notifications(publisher)).items.find(
      (n) => n.kind === "milestone.submitted",
    );
    assert.equal(historical.workContext, null);
    assert.equal(historical.navigationAnchor, null);
    assert.equal(historical.title, "Milestone work submitted");
    assert.equal(
      (await lm.conversation(captain, { agreementId: a.id })).items[0].body,
      "Legacy unchanged message",
    );
    const current = (await lm.agreement(publisher, a.id)).milestones[0];
    await lm.submitMilestone(
      captain,
      current.id,
      submit(current, "New exact work"),
      key(),
    );
    const events = (await lm.notifications(publisher)).items.filter(
      (n) => n.kind === "milestone.submitted",
    );
    assert.equal(events.find((n) => n.id === historical.id).workContext, null);
    assert.equal(
      events.find((n) => n.id !== historical.id).workContext.submissionVersion,
      2,
    );
  } finally {
    if (legacyStore) await legacyStore.close();
    await owner.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});

test("send gate remains held during key wait and rechecks clock expiry before releasing a cached receipt", async () => {
  const s = await signed(),
    actor = s.captain,
    input = {
      agreementId: s.agreement.id,
      body: "Expiry-sensitive cached body",
    },
    once = key();
  await market.sendMessage(actor, input, once);
  const blocker = new pg.Client({
    connectionString: connectionString(
      f.config,
      "migrator",
      new URL(f.urls.app).pathname.slice(1),
    ),
  });
  await blocker.connect();
  try {
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=clock_timestamp()+interval '600 milliseconds' WHERE user_id=$1",
      [actor],
    );
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([actor, "message.send", once])],
    );
    const pending = market.sendMessage(actor, input, once);
    const rejection = assert.rejects(pending, code("membership_required"));
    // Poll PostgreSQL for the real wait rather than assume a scheduling delay.
    let waiting = false;
    for (let i = 0; i < 40; i++) {
      waiting = (
        await f.owner.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_app' AND wait_event='advisory') AS waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(waiting, true);
    await f.owner.query("SET lock_timeout='100ms'");
    await assert.rejects(
      f.owner.query(
        "UPDATE campus.users SET account_status='locked' WHERE id=$1",
        [actor],
      ),
      code("55P03"),
    );
    await new Promise((r) => setTimeout(r, 650));
    await blocker.query("COMMIT");
    await rejection;
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.messages WHERE agreement_id=$1",
          [s.agreement.id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end();
    await f.owner.query("SET lock_timeout='0'");
  }
});

test("message body limit and non-student send eligibility stay compatible", async () => {
  const s = await ordered();
  await f.owner.query(
    "UPDATE campus.affiliations SET can_apply=false WHERE user_id=$1",
    [s.buyer],
  );
  const exact = await market.sendMessage(
    s.buyer,
    { orderId: s.order.id, body: "x".repeat(4000) },
    key(),
  );
  assert.equal(exact.body.length, 4000);
  await assert.rejects(
    market.sendMessage(
      s.buyer,
      { orderId: s.order.id, body: "x".repeat(4001) },
      key(),
    ),
    code("invalid_input"),
  );
  await assert.rejects(
    market.sendMessage(s.buyer, { orderId: s.order.id, body: "  " }, key()),
    code("invalid_input"),
  );
});

test("database message insert gate denies inactive current authority for both scopes and keeps authorized history readable", async () => {
  for (const type of ["agreement", "order"]) {
    const s = type === "agreement" ? await signed(true) : await ordered();
    const actor = s.peer || s.buyer,
      id = s.agreement?.id || s.order.id;
    const sql = `INSERT INTO campus.messages(sender_id,${type === "agreement" ? "agreement_id" : "order_id"},body) VALUES($1,$2,'Raw fixture message') RETURNING id`;
    const counts = async () =>
      (
        await f.owner.query(
          "SELECT (SELECT count(*) FROM campus.messages)::int AS messages,(SELECT count(*) FROM campus.notifications)::int AS notifications",
        )
      ).rows[0];
    const before = await counts();
    const raw = await store.as(actor, (c) => c.query(sql, [actor, id]));
    assert.equal(raw.rows.length, 1);
    const active = await counts();
    assert.equal(active.messages, before.messages + 1);
    assert.equal(
      active.notifications,
      before.notifications + (type === "agreement" ? 2 : 1),
    );
    for (const state of ["restricted", "locked"]) {
      await f.owner.query(
        "UPDATE campus.users SET account_status=$2 WHERE id=$1",
        [actor, state],
      );
      await assert.rejects(
        store.as(actor, (c) => c.query(sql, [actor, id])),
        (e) => ["42501", "P0001"].includes(e.code),
      );
      await assert.rejects(
        store.as(actor, (c) =>
          c.query("SELECT campus.authorize_message_scope($1,$2)", [type, id]),
        ),
        (e) => ["42501", "P0001"].includes(e.code),
      );
      assert.deepEqual(await counts(), active);
      if (state === "restricted")
        assert.equal(
          (await market.conversation(actor, { [`${type}Id`]: id })).items
            .length,
          1,
        );
    }
    await f.owner.query(
      "UPDATE campus.users SET account_status='active' WHERE id=$1",
      [actor],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [actor],
    );
    await assert.rejects(
      store.as(actor, (c) => c.query(sql, [actor, id])),
      code("42501"),
    );
    assert.equal(
      (await market.conversation(actor, { [`${type}Id`]: id })).items.length,
      1,
    );
    assert.deepEqual(await counts(), active);
    await assert.rejects(
      store.as(s.outsider, (c) => c.query(sql, [s.outsider, id])),
      code("P0001"),
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '1 day' WHERE user_id=$1",
      [actor],
    );
    await f.owner.query(
      "UPDATE campus.institutions SET active=false WHERE id=$1",
      [f.institution],
    );
    await assert.rejects(
      store.as(actor, (c) => c.query(sql, [actor, id])),
      code("42501"),
    );
    assert.deepEqual(await counts(), active);
    await f.owner.query(
      "UPDATE campus.institutions SET active=true WHERE id=$1",
      [f.institution],
    );
    const permissions = (
      await f.owner.query(
        "SELECT has_function_privilege('campus_app','campus.guard_message_send()','EXECUTE') AS app,has_function_privilege('campus_auth','campus.guard_message_send()','EXECUTE') AS auth,has_function_privilege('campus_worker','campus.guard_message_send()','EXECUTE') AS worker",
      )
    ).rows[0];
    assert.deepEqual(permissions, { app: false, auth: false, worker: false });
  }
});
