// Ordinary lifecycle/access tests only. No paused-lock or forced-revocation diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import {
  conversationQuery,
  conversationSearchQuery,
  conversationMessageQuery,
  conversationHttpQuery,
} from "../../backend/modules/conversations.mjs";
import { endpoint } from "../../backend/http/endpoint.mjs";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
assert.equal(
  new URL(connectionString(localConfig(), "migrator")).hostname,
  "127.0.0.1",
);
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
assert.match(
  f.owner.connectionParameters.database,
  /^campus_test_[a-f0-9]{32}$/,
);
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
const body = {
  title: "Private application task title",
  category: "Research",
  description: "Synthetic local task",
  rewardCents: 100,
  milestones: [{ title: "Stage", amountCents: 100, deliverable: "Evidence" }],
};
async function setup(teamMode = false) {
  const owner = await f.user("Publisher"),
    applicant = await f.user("Applicant"),
    peer = await f.user("Proposed peer"),
    outsider = await f.user("Later joiner");
  let team;
  if (teamMode) {
    team = await market.createTeam(
      applicant,
      { name: "Application team", context: background },
      key(),
    );
    team = await market.inviteMember(
      applicant,
      team.id,
      { ...rev(team), userId: peer },
      key(),
    );
    team = await market.acceptMembership(peer, team.id, rev(team), key());
  }
  const task = await market.publishTask(owner, body, key());
  const application = await market.apply(
    applicant,
    task.id,
    { proposal: "Plan", ...(team ? { teamId: team.id } : {}) },
    key(),
  );
  return {
    owner,
    applicant,
    peer,
    outsider,
    team,
    task,
    application,
    q: { applicationId: application.id },
  };
}
const counts = async () =>
  (
    await f.owner.query(
      "SELECT (SELECT count(*) FROM campus.messages)::int messages,(SELECT count(*) FROM campus.notifications)::int notifications,(SELECT count(*) FROM campus.idempotency)::int receipts",
    )
  ).rows[0];
const send = (s, actor, body = "Application discussion", k = key()) =>
  market.sendMessage(actor, { ...s.q, body }, k);
const read = (s, actor = s.applicant, extra = {}) =>
  market.conversation(actor, { ...s.q, ...extra });
const direct = (s, actor) =>
  store.as(actor, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,application_id,body) VALUES($1,$2,'Ordinary direct send') RETURNING id",
      [actor, s.application.id],
    ),
  );

test("frozen application roster includes unconfirmed members, current names, former members; excludes later joiners and other applicants", async () => {
  const s = await setup(true);
  const initial = await read(s, s.peer);
  assert.deepEqual(initial.participants.map((p) => p.role).sort(), [
    "applicant",
    "proposed_participant",
    "publisher",
  ]);
  assert.deepEqual(initial.applicationContext, {
    applicationId: s.application.id,
    applicationState: "applied",
    taskStatus: "open",
    canSend: true,
    sendUnavailableReason: null,
    agreementId: null,
  });
  assert.equal(
    (await market.application(s.peer, s.application.id)).members.find(
      (p) => p.user_id === s.peer,
    ).confirmed,
    false,
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET can_apply=false WHERE user_id=$1",
    [s.peer],
  );
  for (const actor of [s.owner, s.applicant, s.peer]) await send(s, actor);
  assert.equal(
    (await market.application(s.peer, s.application.id)).members.find(
      (p) => p.user_id === s.peer,
    ).confirmed,
    false,
  );
  s.team = await market.leaveTeam(s.peer, s.team.id, rev(s.team), key());
  s.team = await market.inviteMember(
    s.applicant,
    s.team.id,
    { ...rev(s.team), userId: s.outsider },
    key(),
  );
  s.team = await market.acceptMembership(
    s.outsider,
    s.team.id,
    rev(s.team),
    key(),
  );
  await send(s, s.peer, "Former member history");
  const other = await market.apply(
    s.outsider,
    s.task.id,
    { proposal: "Separate applicant" },
    key(),
  );
  await assert.rejects(read(s, s.outsider), code("not_found"));
  await assert.rejects(send(s, s.outsider), code("not_found"));
  await assert.rejects(
    market.messages(s.peer, { applicationId: other.id }),
    code("not_found"),
  );
  await store.as(s.peer, (c) =>
    c.query(
      "UPDATE campus.users SET display_name='Current renamed peer' WHERE id=$1",
      [s.peer],
    ),
  );
  assert.equal(
    (await read(s, s.peer)).items[0].author.displayName,
    "Current renamed peer",
  );
  assert.equal(
    (
      await store.as(s.outsider, (c) =>
        c.query("SELECT * FROM campus.conversation_people('application',$1)", [
          s.application.id,
        ]),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await store.as(s.peer, (c) =>
        c.query("SELECT * FROM campus.conversation_people('users',$1)", [
          s.outsider,
        ]),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await store.as(s.peer, (c) =>
        c.query("SELECT id FROM campus.users WHERE id=$1", [s.outsider]),
      )
    ).rowCount,
    0,
  );
});

test("applied/invited sends and exact receipt recovery after withdrawal; absent closed keys definitively record nothing", async () => {
  const s = await setup(),
    input = { ...s.q, body: "Committed before closure" },
    k = key();
  const receipts = await Promise.all([
    market.sendMessage(s.applicant, input, k),
    market.sendMessage(s.applicant, input, k),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  await market.inviteApplicant(s.owner, s.application.id, {}, key());
  assert.equal((await read(s)).applicationContext.applicationState, "invited");
  await send(s, s.owner, "Invited discussion");
  await market.withdrawApplication(s.applicant, s.application.id, {}, key());
  const before = await counts();
  assert.deepEqual(
    await market.sendMessage(s.applicant, input, k),
    receipts[0],
  );
  await assert.rejects(
    market.sendMessage(s.applicant, { ...input, body: "Altered" }, k),
    code("idempotency_conflict"),
  );
  const absent = key();
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      market.sendMessage(s.applicant, input, absent),
      (e) => e.status === 409 && e.code === "application_conversation_closed",
    );
  await assert.rejects(
    direct(s, s.owner),
    (e) =>
      e.code === "P0001" && e.message === "application_conversation_closed",
  );
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int n FROM campus.idempotency WHERE actor_id=$1 AND operation='message.send' AND key=$2",
        [s.applicant, absent],
      )
    ).rows[0].n,
    0,
  );
  const ctx = (await read(s)).applicationContext;
  assert.equal(ctx.canSend, false);
  assert.equal(ctx.sendUnavailableReason, "application_closed");
  const again = await market.apply(
    s.applicant,
    s.task.id,
    { proposal: "Reapplication" },
    key(),
  );
  assert.notEqual(again.id, s.application.id);
  assert.equal(
    (await market.conversation(s.applicant, { applicationId: again.id })).items
      .length,
    0,
  );
  await market.sendMessage(
    s.applicant,
    { applicationId: again.id, body: "New separate scope" },
    key(),
  );
  assert.equal((await read(s)).items.length, 2);
});

test("declined, superseded, accepted and closed task retain read-only discussion; exact agreement handoff never copies messages", async () => {
  const declined = await setup();
  await send(declined, declined.applicant);
  await market.rejectApplication(
    declined.owner,
    declined.application.id,
    {},
    key(),
  );
  assert.equal(
    (await read(declined)).applicationContext.applicationState,
    "declined",
  );
  await assert.rejects(
    send(declined, declined.owner),
    code("application_conversation_closed"),
  );
  const s = await setup();
  const rival = await market.apply(
    s.outsider,
    s.task.id,
    { proposal: "Rival" },
    key(),
  );
  const other = { ...s, q: { applicationId: rival.id }, application: rival };
  await send(s, s.applicant);
  await send(other, s.outsider);
  await market.inviteApplicant(s.owner, s.application.id, {}, key());
  const agreement = await market.acceptInvitation(
    s.applicant,
    s.application.id,
    {},
    key(),
  );
  const ctx = (await read(s)).applicationContext;
  assert.equal(ctx.applicationState, "accepted");
  assert.equal(ctx.agreementId, agreement.id);
  assert.equal(ctx.canSend, false);
  assert.equal(
    (await read(other, s.outsider)).applicationContext.applicationState,
    "superseded",
  );
  assert.equal(
    (await read(other, s.outsider)).applicationContext.agreementId,
    null,
  );
  assert.equal(
    (await market.conversation(s.applicant, { agreementId: agreement.id }))
      .items.length,
    0,
  );
  for (const [scope, actor] of [
    [s, s.owner],
    [other, s.outsider],
  ]) {
    await assert.rejects(
      send(scope, actor),
      code("application_conversation_closed"),
    );
    await assert.rejects(
      direct(scope, actor),
      (e) => e.message === "application_conversation_closed",
    );
  }
  const closed = await setup();
  await send(closed, closed.applicant);
  await f.owner.query("UPDATE campus.tasks SET status='closed' WHERE id=$1", [
    closed.task.id,
  ]);
  assert.equal(
    (await read(closed)).applicationContext.sendUnavailableReason,
    "task_closed",
  );
  await assert.rejects(
    send(closed, closed.applicant),
    code("application_conversation_closed"),
  );
  await assert.rejects(
    direct(closed, closed.owner),
    (e) => e.message === "application_conversation_closed",
  );
});

test("restricted/expired reads retained; no first sends or receipt replay; locked private access and app-role bypass denied", async () => {
  const s = await setup(),
    k = key(),
    input = { ...s.q, body: "Private receipt" };
  const receipt = await market.sendMessage(s.applicant, input, k);
  for (const state of ["restricted", "expired", "locked"]) {
    await f.owner.query(
      "UPDATE campus.users SET account_status=$2 WHERE id=$1",
      [s.applicant, state === "expired" ? "active" : state],
    );
    await f.owner.query(
      "UPDATE campus.affiliations SET valid_until=clock_timestamp()+($2::int*interval '1 day') WHERE user_id=$1",
      [s.applicant, state === "expired" ? -1 : 1],
    );
    const expected =
      state === "expired"
        ? "membership_required"
        : state === "restricted"
          ? "account_restricted"
          : "account_locked";
    const before = await counts();
    await assert.rejects(
      market.sendMessage(s.applicant, input, k),
      code(expected),
    );
    await assert.rejects(send(s, s.applicant), code(expected));
    await assert.rejects(direct(s, s.applicant), (e) =>
      ["42501", "P0001"].includes(e.code),
    );
    if (state === "locked") {
      for (const fn of [
        () => read(s),
        () => market.conversationParticipants(s.applicant, s.q),
        () => market.searchConversation(s.applicant, { ...s.q, q: "Private" }),
        () =>
          market.conversationMessage(s.applicant, {
            ...s.q,
            messageId: receipt.id,
          }),
        () => market.messages(s.applicant, s.q),
        () => market.notifications(s.applicant),
      ])
        await assert.rejects(fn(), code("account_locked"));
      assert.equal(
        (
          await store.as(s.applicant, (c) =>
            c.query("SELECT * FROM campus.messages WHERE application_id=$1", [
              s.application.id,
            ]),
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await store.as(s.applicant, (c) =>
            c.query(
              "SELECT campus.application_conversation_context($1) context",
              [s.application.id],
            ),
          )
        ).rows[0].context,
        null,
      );
    } else {
      assert.equal(
        (await read(s)).applicationContext.sendUnavailableReason,
        expected,
      );
      assert.equal(
        (await market.searchConversation(s.applicant, { ...s.q, q: "Private" }))
          .items.length,
        1,
      );
      assert.equal(
        (
          await market.conversationMessage(s.applicant, {
            ...s.q,
            messageId: receipt.id,
          })
        ).message.id,
        receipt.id,
      );
      assert.equal((await market.messages(s.applicant, s.q)).length, 1);
    }
    assert.deepEqual(await counts(), before);
  }
});

test("application notification recipients include unconfirmed roster, exact message/current author, no stored bodies, expired title redaction", async () => {
  const s = await setup(true),
    k = key(),
    privateBody = "PRIVATE DISCUSSION " + "x".repeat(170);
  const receipt = await send(s, s.owner, privateBody, k);
  await send(s, s.owner, privateBody, k);
  const notices = (
    await f.owner.query(
      "SELECT * FROM campus.notifications WHERE event_key=$1 ORDER BY recipient_id",
      ["message:" + receipt.id],
    )
  ).rows;
  assert.deepEqual(
    notices.map((n) => n.recipient_id).sort(),
    [s.applicant, s.peer].sort(),
  );
  assert.ok(
    notices.every(
      (n) =>
        n.target_type === "application" && n.target_id === s.application.id,
    ),
  );
  assert.ok(!JSON.stringify(notices).includes("PRIVATE DISCUSSION"));
  assert.ok(!JSON.stringify(notices).includes("Publisher"));
  await store.as(s.owner, (c) =>
    c.query(
      "UPDATE campus.users SET display_name='Renamed publisher' WHERE id=$1",
      [s.owner],
    ),
  );
  const notice = (await market.notifications(s.peer)).items.find(
    (n) => n.messageContext?.messageId === receipt.id,
  );
  assert.equal(notice.target.type, "application");
  assert.equal(notice.target.id, s.application.id);
  assert.equal(notice.target.taskId, s.task.id);
  assert.equal(notice.contextLabel, body.title);
  assert.equal(notice.messageContext.author.displayName, "Renamed publisher");
  assert.equal(notice.messageContext.preview.length, 160);
  assert.equal(notice.messageContext.truncated, true);
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [s.peer],
  );
  const expired = (await market.notifications(s.peer)).items.find(
    (n) => n.id === notice.id,
  );
  assert.deepEqual(expired.target, {
    type: "application",
    id: s.application.id,
  });
  assert.equal(expired.contextLabel, null);
  assert.equal(expired.messageContext.messageId, receipt.id);
  assert.ok(!JSON.stringify(expired).includes(body.title));
  assert.equal((await market.notifications(s.outsider)).items.length, 0);
});

test("143 application messages and >100 frozen participants paginate; literal Unicode search/context/cross-scope cursors stay strict", async () => {
  const s = await setup();
  await f.owner.query(
    "WITH people AS (INSERT INTO campus.users(display_name) SELECT 'Proposed '||n FROM generate_series(1,112)n RETURNING id) INSERT INTO campus.application_members(application_id,user_id,confirmed) SELECT $1,id,false FROM people",
    [s.application.id],
  );
  await store.as(s.applicant, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,application_id,body,created_at) SELECT $1,$2,'Literal %_ İ NEEDLE '||n,'2026-01-01T00:00:00.123001Z'::timestamptz+(n/3)*interval '1 microsecond' FROM generate_series(1,143)n",
      [s.applicant, s.application.id],
    ),
  );
  const before = await counts();
  let page = await read(s, s.owner, { limit: "17" }),
    ids = page.items.map((m) => m.id);
  const cursor = page.nextCursor;
  assert.equal(page.participantCount, 114);
  assert.equal(page.participants.length, 100);
  const rest = await market.conversationParticipants(s.owner, {
    ...s.q,
    cursor: page.nextParticipantCursor,
  });
  assert.equal(rest.items.length, 14);
  assert.equal(
    new Set([...page.participants, ...rest.items].map((p) => p.id)).size,
    114,
  );
  while (page.nextCursor) {
    page = await read(s, s.owner, { limit: "17", cursor: page.nextCursor });
    ids.push(...page.items.map((m) => m.id));
  }
  assert.equal(ids.length, 143);
  assert.equal(new Set(ids).size, 143);
  assert.equal((await market.messages(s.owner, s.q)).length, 100);
  for (const q of ["%_", "İ", "needle"]) {
    let search = await market.searchConversation(s.owner, {
        ...s.q,
        q,
        limit: "23",
      }),
      foundIds = search.items.map((m) => m.id);
    const searchCursor = search.nextCursor;
    while (search.nextCursor) {
      search = await market.searchConversation(s.owner, {
        ...s.q,
        q,
        limit: "23",
        cursor: search.nextCursor,
      });
      foundIds.push(...search.items.map((m) => m.id));
    }
    assert.deepEqual(foundIds, ids);
    await assert.rejects(
      read(s, s.owner, { cursor: searchCursor }),
      code("invalid_input"),
    );
    await assert.rejects(
      market.searchConversation(s.owner, {
        ...s.q,
        q: "different",
        cursor: searchCursor,
      }),
      code("invalid_input"),
    );
  }
  const win = await market.conversationMessage(s.owner, {
    ...s.q,
    messageId: ids[70],
  });
  assert.equal(win.older.length, 10);
  assert.equal(win.newer.length, 10);
  assert.equal(win.hasOlder, true);
  assert.equal(win.hasNewer, true);
  assert.equal(
    new Set([...win.older, win.message, ...win.newer].map((m) => m.id)).size,
    21,
  );
  assert.deepEqual(await counts(), before);
  const other = await setup();
  const foreign = await send(other, other.applicant);
  await assert.rejects(
    market.conversationMessage(s.owner, { ...s.q, messageId: foreign.id }),
    code("not_found"),
  );
  await assert.rejects(
    read(other, other.owner, { cursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversationParticipants(s.owner, { ...s.q, cursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversation(s.owner, { orderId: s.application.id, cursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversation(s.owner, { agreementId: s.application.id, cursor }),
    code("invalid_input"),
  );
});

test("three-way strict input, canonical scope-bound cursors and legacy HTTP duplicate rejection", async () => {
  const s = await setup();
  for (const bad of [
    {},
    { ...s.q, orderId: key() },
    { ...s.q, agreementId: key() },
    { ...s.q, orderId: key(), agreementId: key() },
    { applicationId: "bad" },
    { ...s.q, unknown: "x" },
  ]) {
    assert.throws(() => conversationQuery(bad), code("invalid_input"));
    assert.throws(
      () => conversationSearchQuery({ ...bad, q: "x" }),
      code("invalid_input"),
    );
    assert.throws(
      () => conversationMessageQuery({ ...bad, messageId: key() }),
      code("invalid_input"),
    );
    await assert.rejects(market.messages(s.owner, bad), code("invalid_input"));
    await assert.rejects(
      market.sendMessage(s.owner, { ...bad, body: "x" }, key()),
      code("invalid_input"),
    );
  }
  for (const limit of ["0", "51", "01", 1])
    assert.throws(
      () => conversationQuery({ ...s.q, limit }),
      code("invalid_input"),
    );
  for (const q of ["", "x".repeat(161), "x\0"])
    assert.throws(
      () => conversationSearchQuery({ ...s.q, q }),
      code("invalid_input"),
    );
  assert.equal(
    conversationSearchQuery({ ...s.q, q: "😀".repeat(160) }).q.length,
    320,
  );
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "session" },
    auth: { resolve: async () => ({ id: s.owner }) },
  };
  const get = endpoint(
    async () => runtime,
    { method: "GET" },
    ({ actor, request }) =>
      market.messages(actor, conversationHttpQuery(request)),
  );
  for (const suffix of ["&applicationId=" + s.application.id, "&other=1"]) {
    const r = await get(
      new Request(
        "http://127.0.0.1:3020/api/v1/messages?applicationId=" +
          s.application.id +
          suffix,
        { headers: { host: "127.0.0.1:3020" } },
      ),
    );
    assert.equal(r.status, 422);
    assert.equal((await r.json()).code, "invalid_input");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("014 helpers have fixed definer paths, least grants, preserved 013 volatile revalidation and three-scope check", async () => {
  const s = await setup();
  for (const role of ["auth", "worker"])
    for (const sql of [
      "SELECT campus.can_read_application_conversation($1)",
      "SELECT campus.application_conversation_context($1)",
      "SELECT * FROM campus.conversation_people('application',$1)",
      "SELECT campus.authorize_message_scope('application',$1)",
    ])
      await assert.rejects(
        store[role].query(sql, [s.application.id]),
        code("42501"),
      );
  const funcs = (
    await f.owner.query(
      "SELECT proname,prosecdef,provolatile,proconfig FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN ('authorize_message_scope','application_conversation_context','can_read_application_conversation')",
    )
  ).rows;
  for (const fn of funcs) {
    assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes("search_path=pg_catalog, campus, pg_temp"));
  }
  assert.equal(
    funcs.find((fn) => fn.proname === "authorize_message_scope").provolatile,
    "v",
  );
  const def = (
    await f.owner.query(
      "SELECT pg_get_functiondef('campus.authorize_message_scope(text,uuid)'::regprocedure) def",
    )
  ).rows[0].def;
  assert.ok(def.includes("OR member_locked"));
  assert.ok(def.includes("hashtextextended('task:'"));
  const constraints = (
    await f.owner.query(
      "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='campus.messages'::regclass AND conname='messages_exactly_one_scope'",
    )
  ).rows;
  assert.match(
    constraints[0].def,
    /num_nonnulls\(agreement_id, order_id, application_id\) = 1/,
  );
  await assert.rejects(
    store.as(s.owner, (c) => c.query("SELECT campus.notify_message_insert()")),
    code("42501"),
  );
});

test("HTTP closure is a definitive no-record problem, while the original receipt remains 201 and byte-equivalent", async () => {
  const s = await setup(),
    sentKey = key();
  const runtime = {
    market,
    config: { origin: "http://127.0.0.1:3020", cookieName: "session" },
    auth: {
      resolve: async () => ({ id: s.applicant }),
      limitBusiness: async () => {},
    },
  };
  const post = endpoint(
    async () => runtime,
    { method: "POST", status: 201 },
    ({ actor, body, request }) =>
      market.sendMessage(actor, body, request.headers.get("idempotency-key")),
  );
  const request = (k, text = "HTTP committed receipt") =>
    new Request("http://127.0.0.1:3020/api/v1/messages", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3020",
        origin: "http://127.0.0.1:3020",
        "content-type": "application/json",
        "idempotency-key": k,
      },
      body: JSON.stringify({ ...s.q, body: text }),
    });
  const first = await post(request(sentKey));
  assert.equal(first.status, 201);
  const receipt = await first.json();
  await market.inviteApplicant(s.owner, s.application.id, {}, key());
  await market.acceptInvitation(s.applicant, s.application.id, {}, key());
  const before = await counts();
  const replay = await post(request(sentKey));
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), receipt);
  const conflict = await post(request(sentKey, "Different body"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency_conflict");
  const refusal = await post(request(key()));
  assert.equal(refusal.status, 409);
  assert.equal(refusal.headers.get("cache-control"), "no-store");
  const problem = await refusal.json();
  assert.equal(problem.code, "application_conversation_closed");
  assert.match(problem.detail, /No message was recorded/);
  assert.deepEqual(await counts(), before);
});

test("foreign application cannot read any discovery surface or resolve another scope message notification", async () => {
  const s = await setup(),
    receipt = await send(s, s.applicant, "Scoped confidential body");
  for (const fn of [
    () => market.conversation(s.outsider, s.q),
    () => market.conversationParticipants(s.outsider, s.q),
    () => market.searchConversation(s.outsider, { ...s.q, q: "confidential" }),
    () =>
      market.conversationMessage(s.outsider, { ...s.q, messageId: receipt.id }),
    () => market.messages(s.outsider, s.q),
  ])
    await assert.rejects(fn(), code("not_found"));
  const other = await market.apply(
    s.outsider,
    s.task.id,
    { proposal: "Independent room" },
    key(),
  );
  await f.owner.query(
    "INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id) VALUES($1,$2,'message.received','application',$3)",
    [s.outsider, "message:" + receipt.id, other.id],
  );
  const wrongScope = (await market.notifications(s.outsider)).items.find(
    (n) => n.kind === "message.received",
  );
  assert.equal(wrongScope.target.id, other.id);
  assert.equal(wrongScope.messageContext, null);
  assert.ok(!JSON.stringify(wrongScope).includes("confidential"));
  await assert.rejects(
    direct(s, s.outsider),
    (e) => e.code === "P0001" && e.message === "not_found",
  );
});
