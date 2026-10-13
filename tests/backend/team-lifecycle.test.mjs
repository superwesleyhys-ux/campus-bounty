const teamBackground = {
  purpose: "Synthetic research",
  activities: "Read and discuss sources",
  timeCommitment: "One hour weekly",
  projectContext: "",
};
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const rev = (t) => ({ expectedRevision: t.revision });
const target = (t, u) => ({ ...rev(t), userId: u });
const code = (expected) => (error) => error.code === expected;
async function users() {
  const ids = [];
  for (const name of ["Captain", "Peer", "New member", "Outsider"])
    ids.push(await f.user(name));
  return ids;
}

test("invitation cycles, all terminal states, captain transfer, archive, and fresh idempotent receipts", async () => {
  const [a, b, c] = await users();
  const createKey = key(),
    inviteKey = key();
  let t = await market.createTeam(
      a,
      { name: "Lifecycle", context: teamBackground },
      createKey,
    ),
    id = t.id;
  assert.equal(t.own_state, "accepted");
  assert.equal(t.revision, 1);
  await assert.rejects(
    market.inviteMember(a, id, { userId: b }, key()),
    code("invalid_input"),
  );
  const inviteBody = target(t, b);
  t = await market.inviteMember(a, id, inviteBody, inviteKey);
  assert.equal(t.revision, 2);
  await assert.rejects(
    market.acceptMembership(b, id, { expectedRevision: 1 }, key()),
    code("team_revision_changed"),
  );
  const declineBody = rev(t),
    declineKey = key();
  t = await market.declineMembership(b, id, declineBody, declineKey);
  assert.equal(t.own_state, "declined");
  assert.equal(t.owner_id, null);
  assert.equal(t.members.length, 1);
  t = await market.inviteMember(a, id, target(t, b), key());
  const replay = await market.declineMembership(b, id, declineBody, declineKey);
  assert.equal(replay.own_state, "invited");
  assert.equal(replay.revision, t.revision);
  const acceptKey = key(),
    acceptBody = rev(t);
  t = await market.acceptMembership(b, id, acceptBody, acceptKey);
  await assert.rejects(
    market.leaveTeam(a, id, rev(t), key()),
    code("captain_transfer_required"),
  );
  t = await market.removeMember(a, id, b, rev(t), key());
  const oldAccept = await market.acceptMembership(b, id, acceptBody, acceptKey);
  assert.equal(oldAccept.own_state, "removed");
  assert.equal(oldAccept.owner_id, null);
  t = await market.inviteMember(a, id, target(t, b), key());
  assert.equal(
    (await market.acceptMembership(b, id, acceptBody, acceptKey)).own_state,
    "invited",
  );
  t = await market.acceptMembership(b, id, rev(t), key());
  t = await market.transferCaptain(a, id, target(t, b), key());
  assert.equal(t.owner_id, b);
  t = await market.leaveTeam(a, id, rev(t), key());
  assert.equal(t.own_state, "left");
  assert.equal(t.owner_id, null);
  const oldCreate = await market.createTeam(
    a,
    { name: "Lifecycle", context: teamBackground },
    createKey,
  );
  assert.equal(oldCreate.owner_id, null);
  assert.equal(oldCreate.own_state, "left");
  const oldInvite = await market.inviteMember(a, id, inviteBody, inviteKey);
  assert.equal(oldInvite.members.length, 1);
  assert.equal(oldInvite.owner_id, null);
  await assert.rejects(
    market.inviteMember(a, id, target(t, c), key()),
    code("not_owner"),
  );
  t = await market.inviteMember(b, id, target(t, c), key());
  await assert.rejects(
    market.archiveTeam(b, id, rev(t), key()),
    code("team_not_empty"),
  );
  t = await market.revokeInvitation(b, id, c, rev(t), key());
  assert.equal((await market.team(c, id)).own_state, "revoked");
  t = await market.archiveTeam(b, id, rev(t), key());
  assert.equal(t.status, "archived");
  assert.ok(t.archived_at);
  assert.equal(t.can_view_roster, true);
  await assert.rejects(
    market.inviteMember(b, id, target(t, c), key()),
    code("team_archived"),
  );
  const history = (
    await f.owner.query(
      "SELECT action,invitation_version FROM campus.team_membership_events WHERE team_id=$1 AND user_id=$2 ORDER BY created_at,id",
      [id, b],
    )
  ).rows;
  assert.deepEqual(
    history
      .filter((r) => r.action === "invite")
      .map((r) => r.invitation_version),
    [1, 2, 3],
  );
  assert.equal((await market.teams(a))[0].own_state, "left");
});

test("revision races serialize invitation acceptance/revocation and parallel captain edits", async () => {
  const [a, b, c, d] = await users();
  let t = await market.createTeam(
    a,
    { name: "Races", context: teamBackground },
    key(),
  );
  const parallel = await Promise.allSettled([
    market.inviteMember(a, t.id, target(t, b), key()),
    market.inviteMember(a, t.id, target(t, c), key()),
  ]);
  assert.equal(parallel.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    parallel.find((x) => x.status === "rejected").reason.code,
    "team_revision_changed",
  );
  t = await market.team(a, t.id);
  const invited = t.members.find((m) => m.state === "invited").user_id;
  const race = await Promise.allSettled([
    market.acceptMembership(invited, t.id, rev(t), key()),
    market.revokeInvitation(a, t.id, invited, rev(t), key()),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    race.find((x) => x.status === "rejected").reason.code,
    "team_revision_changed",
  );
  await assert.rejects(market.team(d, t.id), code("not_found"));
});

test("expired and restricted members can exit, locked users cannot, and transfer requires only the new captain to remain eligible", async () => {
  const [a, b, c] = await users();
  let t = await market.createTeam(
    a,
    { name: "Eligibility", context: teamBackground },
    key(),
  );
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.acceptMembership(b, t.id, rev(t), key());
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [a],
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [a],
  );
  t = await market.transferCaptain(a, t.id, target(t, b), key());
  t = await market.leaveTeam(a, t.id, rev(t), key());
  assert.equal(t.own_state, "left");
  t = await market.inviteMember(b, t.id, target(t, c), key());
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [c],
  );
  t = await market.declineMembership(c, t.id, rev(t), key());
  assert.equal(t.own_state, "declined");
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [b],
  );
  await assert.rejects(
    market.archiveTeam(b, t.id, rev(t), key()),
    code("account_locked"),
  );
  await assert.rejects(market.team(b, t.id), code("account_locked"));
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [b],
  );
  t = await market.archiveTeam(b, t.id, rev(t), key());
  assert.equal(t.status, "archived");
});

test("application and agreement snapshots retain original membership and captain after live roster changes", async () => {
  const [a, b, c, publisher] = await users();
  let t = await market.createTeam(
    a,
    { name: "Snapshots", context: teamBackground },
    key(),
  );
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.acceptMembership(b, t.id, rev(t), key());
  const task = await market.publishTask(
    publisher,
    {
      title: "Snapshot task",
      category: "Research",
      description: "Synthetic scope",
      rewardCents: 100,
      milestones: [{ title: "Result", amountCents: 100, deliverable: "Data" }],
    },
    key(),
  );
  const app = await market.apply(
    a,
    task.id,
    { proposal: "Work together", teamId: t.id },
    key(),
  );
  await market.consentApplication(b, app.id, {}, key());
  await market.inviteApplicant(publisher, app.id, {}, key());
  const before = (
    await f.owner.query(
      "SELECT user_id,confirmed FROM campus.application_members WHERE application_id=$1 ORDER BY user_id",
      [app.id],
    )
  ).rows;
  t = await market.transferCaptain(a, t.id, target(t, b), key());
  t = await market.leaveTeam(a, t.id, rev(t), key());
  t = await market.inviteMember(b, t.id, target(t, c), key());
  t = await market.acceptMembership(c, t.id, rev(t), key());
  await assert.rejects(market.acceptInvitation(b, app.id, {}, key()));
  const agreement = await market.acceptInvitation(a, app.id, {}, key());
  assert.equal(agreement.captain_id, a);
  assert.deepEqual(
    (
      await f.owner.query(
        "SELECT user_id,confirmed FROM campus.application_members WHERE application_id=$1 ORDER BY user_id",
        [app.id],
      )
    ).rows,
    before,
  );
  const frozen = await market.agreement(a, agreement.id);
  assert.deepEqual(frozen.members.map((m) => m.user_id).sort(), [a, b].sort());
  await assert.rejects(market.agreement(c, agreement.id), code("not_found"));
  t = await market.removeMember(b, t.id, c, rev(t), key());
  t = await market.archiveTeam(b, t.id, rev(t), key());
  assert.deepEqual(
    (await market.agreement(a, agreement.id)).terms,
    frozen.terms,
  );
  const another = await market.publishTask(
    publisher,
    {
      title: "Archived task",
      category: "Research",
      description: "Synthetic scope",
      rewardCents: 100,
      milestones: [{ title: "Result", amountCents: 100, deliverable: "Data" }],
    },
    key(),
  );
  await assert.rejects(
    market.apply(b, another.id, { proposal: "Archived", teamId: t.id }, key()),
    code("team_archived"),
  );
});

test("raw SQL cannot bypass lifecycle, read future rosters, or alter history", async () => {
  const [a, b, c] = await users();
  let t = await market.createTeam(
    a,
    { name: "RLS", context: teamBackground },
    key(),
  );
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.declineMembership(b, t.id, rev(t), key());
  t = await market.inviteMember(a, t.id, target(t, c), key());
  t = await market.acceptMembership(c, t.id, rev(t), key());
  t = await market.transferCaptain(a, t.id, target(t, c), key());
  for (const sql of [
    "UPDATE campus.teams SET revision=999 WHERE id=$1",
    "UPDATE campus.team_members SET state='accepted' WHERE team_id=$1",
    "DELETE FROM campus.team_membership_events WHERE team_id=$1",
  ]) {
    await assert.rejects(
      store.as(a, (db) => db.query(sql, [t.id])),
      code("42501"),
    );
  }
  const view = await store.as(b, async (db) => ({
    teams: (await db.query("SELECT * FROM campus.teams WHERE id=$1", [t.id]))
      .rows,
    people: (await db.query("SELECT * FROM campus.team_people($1)", [t.id]))
      .rows,
    summary: (
      await db.query("SELECT * FROM campus.teams_visible() WHERE id=$1", [t.id])
    ).rows[0],
  }));
  assert.equal(view.teams.length, 0);
  assert.equal(view.people.length, 1);
  assert.equal(view.people[0].user_id, b);
  assert.equal(view.summary.owner_id, null);
  await assert.rejects(
    store.as(b, (db) =>
      db.query("SELECT campus.change_team($1,'accept',$2,$3)", [
        t.id,
        b,
        t.revision,
      ]),
    ),
    (error) => error.message === "membership_state_changed",
  );
});
