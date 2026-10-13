// Round10 Task2: requirement-derived ordinary access/lifecycle checks, authored
// separately from frozen Task1 product code. No product-test imports or lock races.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "../../backend/fixture.mjs";
import {
  localConfig,
  connectionString,
} from "../../../scripts/backend-local.mjs";
import { createStore } from "../../../backend/db/store.mjs";
import { createMarket } from "../../../backend/modules/market.mjs";
assert.equal(
  new URL(connectionString(localConfig(), "migrator")).hostname,
  "127.0.0.1",
);
const f = await fixture();
for (const value of Object.values(f.urls)) {
  const u = new URL(value);
  assert.equal(u.hostname, "127.0.0.1");
  assert.match(u.pathname, /^\/campus_test_[a-f0-9]{32}$/);
}
const store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const code = (c) => (e) => e.code === c;
const rev = (t) => ({ expectedRevision: t.revision });
const context = {
  purpose: "Independent application discussion",
  activities: "Discuss source choices",
  timeCommitment: "One hour",
  projectContext: "Synthetic local fixture",
};
const taskBody = {
  title: "PRIVATE_TASK_TITLE",
  category: "Research",
  description: "PRIVATE_DESCRIPTION",
  rewardCents: 200,
  milestones: [
    { title: "Review sources", deliverable: "Source notes", amountCents: 200 },
  ],
};
async function setup(teamMode = false) {
  const publisher = await f.user("Publisher"),
    applicant = await f.user("Applicant"),
    outsider = await f.user("OUTSIDE_NAME");
  let team, unconfirmed, former;
  if (teamMode) {
    unconfirmed = await f.user("Unconfirmed participant");
    former = await f.user("Former participant");
    team = await market.createTeam(
      applicant,
      { name: "Discussion team", context },
      key(),
    );
    for (const person of [unconfirmed, former]) {
      team = await market.inviteMember(
        applicant,
        team.id,
        { ...rev(team), userId: person },
        key(),
      );
      team = await market.acceptMembership(person, team.id, rev(team), key());
    }
  }
  const task = await market.publishTask(publisher, taskBody, key());
  const application = await market.apply(
    applicant,
    task.id,
    { proposal: "PRIVATE_PROPOSAL", ...(team ? { teamId: team.id } : {}) },
    key(),
  );
  // Team joining/application snapshot require student eligibility; discussion does not.
  // Expire only student eligibility after legitimate membership/snapshot creation.
  if (unconfirmed)
    await f.owner.query(
      "UPDATE campus.affiliations SET can_apply=false,student_valid_until=NULL WHERE user_id=$1",
      [unconfirmed],
    );
  return {
    publisher,
    applicant,
    outsider,
    unconfirmed,
    former,
    team,
    task,
    application,
    scope: { applicationId: application.id },
  };
}
const rawMembers = async (id) =>
  (
    await f.owner.query(
      "SELECT * FROM campus.application_members WHERE application_id=$1 ORDER BY user_id",
      [id],
    )
  ).rows;
const writeState = async () =>
  (
    await f.owner.query(`SELECT
  (SELECT count(*)::int FROM campus.messages) AS messages,
  (SELECT count(*)::int FROM campus.notifications) AS notifications,
  (SELECT count(*)::int FROM campus.idempotency) AS receipts,
  (SELECT count(*)::int FROM campus.agreements) AS agreements`)
  ).rows[0];
const inbox = async (actor) =>
  (await market.notifications(actor, { limit: "50" })).items;
async function deniedReads(actor, scope, messageId, expected = "not_found") {
  for (const fn of [
    () => market.conversation(actor, scope),
    () => market.conversationParticipants(actor, scope),
    () => market.searchConversation(actor, { ...scope, q: "PRIVATE" }),
    () => market.conversationMessage(actor, { ...scope, messageId }),
    () => market.messages(actor, scope),
  ])
    await assert.rejects(fn(), code(expected));
}
async function terminalReceipt(
  s,
  state,
  receipt,
  requestKey,
  agreementId = null,
) {
  const before = await writeState();
  const page = await market.conversation(s.applicant, s.scope);
  assert.equal(page.applicationContext.applicationState, state);
  assert.equal(page.applicationContext.canSend, false);
  assert.equal(
    page.applicationContext.sendUnavailableReason,
    "application_closed",
  );
  assert.equal(page.applicationContext.agreementId, agreementId);
  assert.equal(page.items.find((x) => x.id === receipt.id).body, receipt.body);
  assert.deepEqual(
    await market.sendMessage(
      s.applicant,
      { ...s.scope, body: receipt.body },
      requestKey,
    ),
    receipt,
  );
  await assert.rejects(
    market.sendMessage(s.applicant, { ...s.scope, body: receipt.body }, key()),
    code("application_conversation_closed"),
  );
  await assert.rejects(
    market.sendMessage(
      s.applicant,
      { ...s.scope, body: "Changed body" },
      requestKey,
    ),
    code("idempotency_conflict"),
  );
  assert.deepEqual(
    await writeState(),
    before,
    "Reads, receipt replay, conflict and definitive closed-key refusal produce no writes",
  );
}

test("application snapshot includes unconfirmed and former people; later teammates, other applicants and outsiders cannot use any discovery surface", async () => {
  const s = await setup(true),
    later = await f.user("LATER_NAME");
  const membersBefore = await rawMembers(s.application.id);
  assert.equal(
    membersBefore.find((x) => x.user_id === s.unconfirmed).confirmed,
    false,
  );
  assert.equal(
    membersBefore.find((x) => x.user_id === s.former).confirmed,
    false,
  );
  let team = await market.leaveTeam(s.former, s.team.id, rev(s.team), key());
  team = await market.inviteMember(
    s.applicant,
    team.id,
    { ...rev(team), userId: later },
    key(),
  );
  await market.acceptMembership(later, team.id, rev(team), key());
  const competing = await market.apply(
    s.outsider,
    s.task.id,
    { proposal: "Foreign applicant" },
    key(),
  );
  const sent = await market.sendMessage(
    s.unconfirmed,
    { ...s.scope, body: "PRIVATE_DISCUSSION" },
    key(),
  );
  await market.sendMessage(
    s.former,
    { ...s.scope, body: "Former member can discuss" },
    key(),
  );
  await f.owner.query(
    "UPDATE campus.users SET display_name='Current unconfirmed name',bio='BIO_SECRET' WHERE id=$1",
    [s.unconfirmed],
  );
  const expected = new Map([
    [s.publisher, "publisher"],
    [s.applicant, "applicant"],
    [s.unconfirmed, "proposed_participant"],
    [s.former, "proposed_participant"],
  ]);
  for (const actor of expected.keys()) {
    const page = await market.conversation(actor, s.scope);
    assert.deepEqual(
      new Map(page.participants.map((x) => [x.id, x.role])),
      expected,
    );
    assert.equal(page.participantCount, 4);
    assert.equal(page.applicationContext.canSend, true);
    assert.deepEqual(page.items.find((x) => x.id === sent.id).author, {
      id: s.unconfirmed,
      displayName: "Current unconfirmed name",
      role: "proposed_participant",
    });
    assert.equal(
      (await market.searchConversation(actor, { ...s.scope, q: "PRIVATE" }))
        .items[0].id,
      sent.id,
    );
    assert.equal(
      (
        await market.conversationMessage(actor, {
          ...s.scope,
          messageId: sent.id,
        })
      ).message.id,
      sent.id,
    );
    assert.ok(
      !JSON.stringify(page).match(
        /BIO_SECRET|PRIVATE_PROPOSAL|OUTSIDE_NAME|LATER_NAME|institution_id|valid_until/,
      ),
    );
    for (const p of page.participants)
      assert.deepEqual(Object.keys(p).sort(), ["displayName", "id", "role"]);
  }
  for (const actor of [later, s.outsider]) {
    await deniedReads(actor, s.scope, sent.id);
    await assert.rejects(
      market.sendMessage(
        actor,
        { ...s.scope, body: "Must be rejected" },
        key(),
      ),
      code("not_found"),
    );
    assert.equal(
      (
        await store.as(actor, (c) =>
          c.query("SELECT * FROM campus.messages WHERE application_id=$1", [
            s.application.id,
          ]),
        )
      ).rowCount,
      0,
    );
  }
  await assert.rejects(
    market.conversationMessage(s.publisher, {
      applicationId: competing.id,
      messageId: sent.id,
    }),
    code("not_found"),
  );
  assert.deepEqual(
    await rawMembers(s.application.id),
    membersBefore,
    "Discussion neither signs nor changes the original consent snapshot",
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int n FROM campus.agreements WHERE task_id=$1",
        [s.task.id],
      )
    ).rows[0].n,
    0,
  );
});

test("withdrawal preserves the original receipt and history while reapplication has a separate scope and no inherited messages", async () => {
  const s = await setup(),
    requestKey = key();
  const sent = await market.sendMessage(
    s.applicant,
    { ...s.scope, body: "PRIVATE_ORIGINAL" },
    requestKey,
  );
  await market.sendMessage(
    s.publisher,
    { ...s.scope, body: "Second original" },
    key(),
  );
  const oldPage = await market.conversation(s.applicant, {
    ...s.scope,
    limit: "1",
  });
  await market.withdrawApplication(s.applicant, s.application.id, {}, key());
  await terminalReceipt(s, "withdrawn", sent, requestKey);
  const next = await market.apply(
    s.applicant,
    s.task.id,
    { proposal: "Fresh application" },
    key(),
  );
  assert.notEqual(next.id, s.application.id);
  const scope = { applicationId: next.id };
  assert.deepEqual((await market.conversation(s.applicant, scope)).items, []);
  assert.equal(
    (await market.conversation(s.applicant, scope)).applicationContext.canSend,
    true,
  );
  await assert.rejects(
    market.conversationMessage(s.applicant, { ...scope, messageId: sent.id }),
    code("not_found"),
  );
  await assert.rejects(
    market.conversation(s.applicant, { ...scope, cursor: oldPage.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.sendMessage(s.applicant, { ...scope, body: sent.body }, requestKey),
    code("idempotency_conflict"),
  );
  const fresh = await market.sendMessage(
    s.applicant,
    { ...scope, body: "Fresh discussion" },
    key(),
  );
  assert.equal(fresh.application_id, next.id);
  assert.equal(
    (await market.messages(s.applicant, s.scope)).some(
      (x) => x.id === fresh.id,
    ),
    false,
  );
});

for (const terminal of ["declined", "superseded", "accepted"])
  test(`${terminal} via ordinary lifecycle retains read-only scope and identical receipt; accepted handoff selects only its own agreement`, async () => {
    const s = await setup(),
      requestKey = key();
    const sent = await market.sendMessage(
      s.applicant,
      { ...s.scope, body: "PRIVATE_TERMINAL" },
      requestKey,
    );
    let agreement;
    if (terminal === "declined")
      await market.rejectApplication(s.publisher, s.application.id, {}, key());
    else {
      await market.inviteApplicant(s.publisher, s.application.id, {}, key());
      assert.equal(
        (await market.conversation(s.applicant, s.scope)).applicationContext
          .canSend,
        true,
      );
      await market.sendMessage(
        s.publisher,
        { ...s.scope, body: "Invitation discussion is open" },
        key(),
      );
      if (terminal === "accepted")
        agreement = await market.acceptInvitation(
          s.applicant,
          s.application.id,
          {},
          key(),
        );
      else {
        const other = await market.apply(
          s.outsider,
          s.task.id,
          { proposal: "Alternative" },
          key(),
        );
        await market.inviteApplicant(s.publisher, other.id, {}, key());
        await market.acceptInvitation(s.outsider, other.id, {}, key());
      }
    }
    await terminalReceipt(s, terminal, sent, requestKey, agreement?.id ?? null);
    if (agreement) {
      assert.deepEqual(
        (await market.conversation(s.applicant, { agreementId: agreement.id }))
          .items,
        [],
      );
      await assert.rejects(
        market.conversationMessage(s.applicant, {
          agreementId: agreement.id,
          messageId: sent.id,
        }),
        code("not_found"),
      );
      const post = await market.sendMessage(
        s.applicant,
        { agreementId: agreement.id, body: "Separate fulfillment discussion" },
        key(),
      );
      assert.deepEqual(Object.keys(post).sort(), [
        "agreement_id",
        "body",
        "created_at",
        "id",
        "order_id",
        "sender_id",
      ]);
      assert.equal(
        (await market.messages(s.applicant, s.scope)).some(
          (x) => x.id === post.id,
        ),
        false,
      );
    }
  });

test("non-open task refuses a never-committed key while a committed key remains recoverable", async () => {
  const s = await setup(),
    requestKey = key();
  const sent = await market.sendMessage(
    s.applicant,
    { ...s.scope, body: "Original open task" },
    requestKey,
  );
  // Fixture owner sets an ordinary documented task state; no locks/revocation/paused sends.
  await f.owner.query("UPDATE campus.tasks SET status='closed' WHERE id=$1", [
    s.task.id,
  ]);
  const before = await writeState(),
    page = await market.conversation(s.applicant, s.scope);
  assert.equal(page.applicationContext.applicationState, "applied");
  assert.equal(page.applicationContext.taskStatus, "closed");
  assert.equal(page.applicationContext.sendUnavailableReason, "task_closed");
  assert.equal(page.applicationContext.canSend, false);
  await assert.rejects(
    market.sendMessage(
      s.applicant,
      { ...s.scope, body: "Never committed" },
      key(),
    ),
    code("application_conversation_closed"),
  );
  assert.deepEqual(
    await market.sendMessage(
      s.applicant,
      { ...s.scope, body: sent.body },
      requestKey,
    ),
    sent,
  );
  assert.deepEqual(await writeState(), before);
});

for (const status of ["restricted", "expired", "locked"])
  test(`current ${status} authority governs every read and committed receipt recovery without a queued operation`, async () => {
    const s = await setup(),
      requestKey = key(),
      sent = await market.sendMessage(
        s.applicant,
        { ...s.scope, body: "PRIVATE_CURRENT_AUTHORITY" },
        requestKey,
      );
    if (status === "expired")
      await f.owner.query(
        "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
        [s.applicant],
      );
    else
      await f.owner.query(
        "UPDATE campus.users SET account_status=$2 WHERE id=$1",
        [s.applicant, status],
      );
    const expected =
        status === "expired" ? "membership_required" : `account_${status}`,
      before = await writeState();
    if (status === "locked")
      await deniedReads(s.applicant, s.scope, sent.id, expected);
    else {
      const page = await market.conversation(s.applicant, s.scope);
      assert.equal(page.items[0].id, sent.id);
      assert.equal(page.applicationContext.canSend, false);
      assert.equal(page.applicationContext.sendUnavailableReason, expected);
      assert.equal(
        (
          await market.searchConversation(s.applicant, {
            ...s.scope,
            q: "PRIVATE",
          })
        ).items[0].id,
        sent.id,
      );
      assert.equal(
        (
          await market.conversationMessage(s.applicant, {
            ...s.scope,
            messageId: sent.id,
          })
        ).message.id,
        sent.id,
      );
    }
    await assert.rejects(
      market.sendMessage(
        s.applicant,
        { ...s.scope, body: sent.body },
        requestKey,
      ),
      code(expected),
    );
    await assert.rejects(
      market.sendMessage(
        s.applicant,
        { ...s.scope, body: "Fresh denied" },
        key(),
      ),
      code(expected),
    );
    assert.deepEqual(await writeState(), before);
  });

test("message notifications go to exactly the original snapshot except sender; current author and recipient authorization govern previews and acknowledgments", async () => {
  const s = await setup(true),
    sent = await market.sendMessage(
      s.unconfirmed,
      { ...s.scope, body: "PRIVATE_MESSAGE_BODY" },
      key(),
    );
  const notes = (
    await f.owner.query(
      "SELECT * FROM campus.notifications WHERE event_key=$1 ORDER BY recipient_id",
      [`message:${sent.id}`],
    )
  ).rows;
  assert.deepEqual(
    notes.map((x) => x.recipient_id).sort(),
    [s.publisher, s.applicant, s.former].sort(),
  );
  assert.ok(
    notes.every(
      (x) =>
        x.target_type === "application" &&
        x.target_id === s.application.id &&
        x.read_at === null,
    ),
  );
  assert.ok(
    !JSON.stringify(notes).match(
      /PRIVATE_MESSAGE_BODY|PRIVATE_TASK_TITLE|Unconfirmed participant/,
    ),
  );
  await f.owner.query(
    "UPDATE campus.users SET display_name='Renamed sender' WHERE id=$1",
    [s.unconfirmed],
  );
  const n = (await inbox(s.publisher)).find(
    (x) => x.messageContext?.messageId === sent.id,
  );
  assert.deepEqual(n.target, {
    type: "application",
    id: s.application.id,
    taskId: s.task.id,
  });
  assert.equal(n.contextLabel, "PRIVATE_TASK_TITLE");
  assert.deepEqual(n.messageContext.author, {
    id: s.unconfirmed,
    displayName: "Renamed sender",
    role: "proposed_participant",
  });
  assert.equal(n.messageContext.preview, "PRIVATE_MESSAGE_BODY");
  assert.equal(n.readAt, null);
  await assert.rejects(
    market.readNotification(s.outsider, n.id, {}, key()),
    code("not_found"),
  );
  assert.equal(
    (
      await store.as(s.outsider, (c) =>
        c.query("SELECT * FROM campus.notifications WHERE id=$1", [n.id]),
      )
    ).rowCount,
    0,
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [s.publisher],
  );
  const expired = (await inbox(s.publisher)).find((x) => x.id === n.id);
  assert.deepEqual(expired.target, {
    type: "application",
    id: s.application.id,
  });
  assert.equal(expired.contextLabel, null);
  assert.equal(expired.messageContext.messageId, sent.id);
  const ackKey = key(),
    ack = await market.readNotification(s.publisher, n.id, {}, ackKey);
  assert.ok(ack.readAt);
  assert.equal(
    (await market.readNotification(s.publisher, n.id, {}, ackKey)).readAt,
    ack.readAt,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [s.publisher],
  );
  await assert.rejects(
    market.readNotification(s.publisher, n.id, {}, ackKey),
    code("account_locked"),
  );
  await assert.rejects(
    market.notifications(s.publisher),
    code("account_locked"),
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int n FROM campus.notifications WHERE event_key=$1",
        [`message:${sent.id}`],
      )
    ).rows[0].n,
    3,
  );
});

test("history, literal search and participant cursors are independent and application-bound; exact context cannot select a foreign message", async () => {
  const s = await setup(true),
    other = await setup(),
    sent = [];
  for (let i = 0; i < 7; i++)
    sent.push(
      await market.sendMessage(
        s.applicant,
        { ...s.scope, body: `Discussion %_${i} Unicode 界` },
        key(),
      ),
    );
  const first = await market.conversation(s.publisher, {
      ...s.scope,
      limit: "2",
    }),
    all = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const p = await market.conversation(s.publisher, {
      ...s.scope,
      limit: "2",
      cursor,
    });
    all.push(...p.items);
    cursor = p.nextCursor;
  }
  assert.deepEqual(
    all.map((x) => x.id),
    sent.map((x) => x.id).reverse(),
  );
  const search = await market.searchConversation(s.publisher, {
    ...s.scope,
    q: "%_",
    limit: "2",
  });
  assert.equal(search.items.length, 2);
  assert.ok(search.nextCursor);
  assert.equal(
    (await market.searchConversation(s.publisher, { ...s.scope, q: "%_3" }))
      .items[0].id,
    sent[3].id,
  );
  const people = await market.conversationParticipants(s.publisher, {
    ...s.scope,
    limit: "2",
  });
  assert.ok(people.nextCursor);
  assert.equal(
    (
      await market.conversationParticipants(s.publisher, {
        ...s.scope,
        limit: "2",
        cursor: people.nextCursor,
      })
    ).items.length,
    2,
  );
  await assert.rejects(
    market.conversation(other.publisher, {
      ...other.scope,
      cursor: first.nextCursor,
    }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.searchConversation(other.publisher, {
      ...other.scope,
      q: "%_",
      cursor: search.nextCursor,
    }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversationParticipants(other.publisher, {
      ...other.scope,
      cursor: people.nextCursor,
    }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversation(s.publisher, { ...s.scope, cursor: search.nextCursor }),
    code("invalid_input"),
  );
  await assert.rejects(
    market.conversationMessage(other.publisher, {
      ...other.scope,
      messageId: sent[3].id,
    }),
    code("not_found"),
  );
  const exact = await market.conversationMessage(s.publisher, {
    ...s.scope,
    messageId: sent[3].id,
  });
  assert.equal(exact.message.id, sent[3].id);
  assert.deepEqual(
    [...exact.older, exact.message, ...exact.newer].map((x) => x.id),
    sent.map((x) => x.id),
  );
});
