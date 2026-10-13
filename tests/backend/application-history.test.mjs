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
const code = (expected) => (error) => error.code === expected;
const body = {
  title: "PRIVATE CAMPUS TITLE",
  category: "Writing",
  description: "Campus-only task description",
  rewardCents: 100,
  milestones: [
    { title: "Draft", amountCents: 100, deliverable: "A concise guide" },
  ],
};
async function users(n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await f.user(`History person ${i}`));
  return ids;
}
async function expire(id) {
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [id],
  );
}

test("single application history: expired publisher received/withdrawn targets remain exact and campus title stays redacted", async () => {
  const [publisher, applicant, outsider] = await users(3);
  const t = await market.publishTask(publisher, body, key());
  const a = await market.apply(
    applicant,
    t.id,
    { proposal: "Private submitted proposal" },
    key(),
  );
  const received = (await market.notifications(publisher, {})).items[0];
  assert.equal(received.kind, "application.received");
  assert.deepEqual((await market.application(publisher, a.id)).task, {
    id: t.id,
    title: body.title,
  });
  await expire(publisher);
  for (const notification of [
    (await market.notifications(publisher, {})).items[0],
  ]) {
    assert.equal(notification.target.id, a.id);
    assert.equal(notification.target.taskId, undefined);
    const detail = await market.application(publisher, notification.target.id);
    assert.equal(detail.id, a.id);
    assert.equal(detail.proposal, "Private submitted proposal");
    assert.equal(detail.task, null);
    assert.deepEqual(Object.keys(detail).sort(), [
      "created_at",
      "id",
      "members",
      "proposal",
      "state",
      "task",
    ]);
    assert.ok(!JSON.stringify(detail).includes(body.title));
  }
  assert.equal((await market.myApplications(publisher)).length, 0);
  await market.withdrawApplication(applicant, a.id, {}, key());
  const withdrawn = (await market.notifications(publisher, {})).items.find(
    (n) => n.kind === "application.withdrawn",
  );
  assert.equal(
    (await market.application(publisher, withdrawn.target.id)).state,
    "withdrawn",
  );
  await assert.rejects(
    market.task(publisher, t.id),
    code("membership_required"),
  );
  await assert.rejects(market.application(outsider, a.id), code("not_found"));
  await assert.rejects(
    market.application(applicant, "not-a-uuid"),
    code("invalid_input"),
  );
  await assert.rejects(market.application(applicant, key()), code("not_found"));
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [publisher],
  );
  await assert.rejects(
    market.application(publisher, a.id),
    code("account_locked"),
  );
});

test("application history uses frozen members, denies revoked team invitees and rechecks current application access", async () => {
  const [publisher, applicant, peer, revoked] = await users(4);
  let team = await market.createTeam(
    applicant,
    {
      name: "History team",
      context: {
        purpose: "Write a guide",
        activities: "Review text",
        timeCommitment: "One hour",
        projectContext: "",
      },
    },
    key(),
  );
  team = await market.inviteMember(
    applicant,
    team.id,
    { expectedRevision: team.revision, userId: peer },
    key(),
  );
  team = await market.acceptMembership(
    peer,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  team = await market.inviteMember(
    applicant,
    team.id,
    { expectedRevision: team.revision, userId: revoked },
    key(),
  );
  team = await market.revokeInvitation(
    applicant,
    team.id,
    revoked,
    { expectedRevision: team.revision },
    key(),
  );
  const t = await market.publishTask(publisher, body, key());
  const a = await market.apply(
    applicant,
    t.id,
    { proposal: "Frozen member proposal", teamId: team.id },
    key(),
  );
  await market.consentApplication(peer, a.id, {}, key());
  await market.leaveTeam(
    peer,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  await expire(peer);
  await expire(applicant);
  assert.equal((await market.application(peer, a.id)).id, a.id);
  assert.equal((await market.application(applicant, a.id)).task, null);
  await assert.rejects(market.application(revoked, a.id), code("not_found"));
  // Fault fixture: remove one historical authorization row as owner to prove no cached DTO bypass.
  await f.owner.query(
    "DELETE FROM campus.application_members WHERE application_id=$1 AND user_id=$2",
    [a.id, peer],
  );
  await assert.rejects(market.application(peer, a.id), code("not_found"));
});

test("single application target is independent of the existing latest-100 list limit", async () => {
  const [publisher, applicant] = await users(2);
  const t = await market.publishTask(publisher, body, key());
  const original = await market.apply(
    applicant,
    t.id,
    { proposal: "Old exact proposal" },
    key(),
  );
  await market.inviteApplicant(publisher, original.id, {}, key());
  const originalNotice = (await market.notifications(applicant, {})).items[0];
  await market.withdrawApplication(applicant, original.id, {}, key());
  for (let i = 0; i < 100; i++) {
    const a = await market.apply(
      applicant,
      t.id,
      { proposal: `Newer proposal ${i}` },
      key(),
    );
    await market.withdrawApplication(applicant, a.id, {}, key());
  }
  await expire(applicant);
  const list = await market.myApplications(applicant);
  assert.equal(list.length, 100);
  assert.ok(!list.some((a) => a.id === original.id));
  assert.equal(
    (await market.application(applicant, originalNotice.target.id)).proposal,
    "Old exact proposal",
  );
  assert.equal((await market.application(applicant, original.id)).task, null);
});
