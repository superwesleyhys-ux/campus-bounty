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
import { dollarsToCents } from "../../src/lib/shared-input.mjs";

test("currency entry rejects rounding, non-finite and out-of-range amounts", () => {
  assert.equal(dollarsToCents("0.29"), 29);
  assert.equal(dollarsToCents("123.4"), 12340);
  assert.equal(dollarsToCents("0", { zero: true }), 0);
  for (const input of [
    "1.005",
    "1e2",
    "NaN",
    "-1",
    "0",
    "1000001",
    "1,000",
    "",
  ])
    assert.throws(() => dollarsToCents(input));
});

test("catalog filtering applies before pagination; literal search and owner scope stay bounded", async () => {
  const f = await fixture(),
    store = createStore(f.urls),
    market = createMarket(store);
  try {
    const a = await f.user("Publisher"),
      b = await f.user("Other");
    for (let i = 0; i < 15; i++)
      await market.publishTask(
        a,
        {
          title: `Research ${i}`,
          category: "Research",
          description: "Data analysis",
          rewardCents: i + 100,
          milestones: [
            { title: "Data", deliverable: "Report", amountCents: i + 100 },
          ],
        },
        randomUUID(),
      );
    const selected = await market.publishTask(
      b,
      {
        title: "100%_literal",
        category: "Design",
        description: "A specific matching target",
        rewardCents: 900,
        milestones: [{ title: "Art", deliverable: "Source", amountCents: 900 }],
      },
      randomUUID(),
    );
    const all = await market.tasks(a, {
      q: "Research",
      sort: "amount_asc",
      offset: 12,
      limit: 3,
    });
    assert.equal(all.total, 15);
    assert.deepEqual(
      all.items.map((t) => t.reward_cents),
      [112, 113, 114],
    );
    assert.equal((await market.tasks(a, { q: "%_" })).items[0].id, selected.id);
    assert.equal(
      (await market.tasks(a, { category: "Design", scope: "mine" })).total,
      0,
    );
    assert.equal((await market.tasks(b, { scope: "mine" })).total, 1);
    assert.equal((await market.tasks(a, { offset: 99 })).total, 16);
    await assert.rejects(
      market.tasks(a, { sort: "title;DROP TABLE" }),
      (e) => e.status === 422,
    );
    await assert.rejects(
      market.tasks(a, { q: "x".repeat(121) }),
      (e) => e.status === 422,
    );
    for (let i = 0; i < 3; i++)
      await market.publishProduct(
        a,
        {
          title: `Book ${i}`,
          description: "Textbook",
          priceCents: 100 + i,
          stock: 1,
          deliveryMethods: ["pickup"],
        },
        randomUUID(),
      );
    const products = await market.products(b, {
      q: "Book",
      limit: 1,
      offset: 1,
      sort: "amount_desc",
    });
    assert.equal(products.total, 3);
    assert.equal(products.items[0].price_cents, 101);
    assert.equal((await market.products(b, { scope: "mine" })).total, 0);
  } finally {
    await store.close();
    await f.close();
  }
});

test("application inbox exposes consent to participants, never unrelated accounts", async () => {
  const f = await fixture(),
    store = createStore(f.urls),
    market = createMarket(store);
  try {
    const owner = await f.user("Publisher"),
      captain = await f.user("Captain"),
      peer = await f.user("Peer"),
      stranger = await f.user("Stranger");
    const team = await market.createTeam(
      captain,
      { name: "Students", context: teamBackground },
      randomUUID(),
    );
    await market.inviteMember(
      captain,
      team.id,
      { userId: peer, expectedRevision: team.revision },
      randomUUID(),
    );
    await market.acceptMembership(
      peer,
      team.id,
      { expectedRevision: team.revision + 1 },
      randomUUID(),
    );
    const people = (await market.team(captain, team.id)).members;
    assert.equal(people.find((m) => m.user_id === peer).display_name, "Peer");
    assert.deepEqual(
      await market.teamCandidate(captain, team.id, { userId: peer }),
      { user_id: peer, display_name: "Peer" },
    );
    for (const actor of [peer, stranger])
      await assert.rejects(
        market.teamCandidate(actor, team.id, { userId: captain }),
        (e) => e.status === 404,
      );
    const ineligible = await f.user("Faculty", false);
    await assert.rejects(
      market.teamCandidate(captain, team.id, { userId: ineligible }),
      (e) => e.status === 404,
    );
    await assert.rejects(
      market.team(stranger, team.id),
      (e) => e.status === 404,
    );
    const task = await market.publishTask(
      owner,
      {
        title: "Campus research",
        description: "Field survey",
        category: "Research",
        rewardCents: 100,
        milestones: [
          { title: "Report", amountCents: 100, deliverable: "Summary" },
        ],
      },
      randomUUID(),
    );
    const a = await market.apply(
      captain,
      task.id,
      { teamId: team.id, proposal: "We will survey" },
      randomUUID(),
    );
    const inbox = await market.myApplications(peer);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].id, a.id);
    assert.equal(inbox[0].task_title, task.title);
    assert.equal(
      inbox[0].members.find((m) => m.user_id === peer).display_name,
      "Peer",
    );
    assert.equal(
      inbox[0].members.find((m) => m.user_id === peer).confirmed,
      false,
    );
    assert.equal((await market.myApplications(stranger)).length, 0);
    assert.equal((await market.applications(stranger, task.id)).length, 0);
    assert.equal(
      (await market.applications(owner, task.id))[0].members.length,
      2,
    );
    await market.consentApplication(peer, a.id, {}, randomUUID());
    assert.ok(
      (await market.myApplications(captain))[0].members.every(
        (m) => m.confirmed,
      ),
    );
  } finally {
    await store.close();
    await f.close();
  }
});
