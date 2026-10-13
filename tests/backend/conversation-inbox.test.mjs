import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { inboxQuery } from "../../backend/modules/conversation-inbox.mjs";
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
test("inbox validates bounded and actor-specific continuation", () => {
  const actor = key();
  for (const input of [
    { limit: "0" },
    { limit: "51" },
    { limit: "1.1" },
    { userId: actor },
    { cursor: "garbage" },
  ])
    assert.throws(() => inboxQuery(actor, input));
});
test("publisher and applicant see only authorized scopes, paginated terminal history and safe expired labels", async () => {
  const owner = await f.user("Owner"),
    applicant = await f.user("Applicant"),
    outsider = await f.user("Outsider");
  const apps = [];
  for (let i = 0; i < 3; i++) {
    const task = await market.publishTask(
      owner,
      {
        title: `PRIVATE INBOX ${i}`,
        description: "Synthetic",
        category: "Research",
        rewardCents: 100,
        milestones: [{ title: "One", deliverable: "File", amountCents: 100 }],
      },
      key(),
    );
    const app = await market.apply(
      applicant,
      task.id,
      { proposal: "Proposal" },
      key(),
    );
    apps.push(app.id);
  }
  const first = await market.conversationInbox(owner, { limit: "2" });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await market.conversationInbox(owner, {
    limit: "2",
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((x) => x.id)).size,
    3,
  );
  assert.equal((await market.conversationInbox(applicant, {})).items.length, 3);
  assert.deepEqual((await market.conversationInbox(outsider, {})).items, []);
  await assert.rejects(
    market.conversationInbox(applicant, { cursor: first.nextCursor }),
    (e) => e.status === 422,
  );
  await market.withdrawApplication(applicant, apps[0], {}, key());
  assert.equal(
    (await market.conversationInbox(owner, {})).items.find(
      (x) => x.id === apps[0],
    ).state,
    "withdrawn",
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [owner],
  );
  const expired = await market.conversationInbox(owner, {});
  assert.equal(expired.items.length, 3);
  assert.ok(expired.items.every((x) => x.title === null));
  assert.ok(!JSON.stringify(expired).includes("PRIVATE INBOX"));
});
test("agreement and order scopes appear for their exact participants only", async () => {
  const owner = await f.user("Publisher"),
    applicant = await f.user("Applicant"),
    outsider = await f.user("Other");
  const task = await market.publishTask(
    owner,
    {
      title: "Agreement inbox",
      description: "Synthetic",
      category: "Research",
      rewardCents: 100,
      milestones: [{ title: "One", deliverable: "File", amountCents: 100 }],
    },
    key(),
  );
  const app = await market.apply(
    applicant,
    task.id,
    { proposal: "Proposal" },
    key(),
  );
  await market.inviteApplicant(owner, app.id, {}, key());
  const agreement = await market.acceptInvitation(applicant, app.id, {}, key());
  const product = await market.publishProduct(
    owner,
    {
      title: "Order inbox",
      description: "Synthetic",
      priceCents: 100,
      stock: 1,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const quote = await market.quote(
    applicant,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order = await market.order(applicant, { quoteId: quote.id }, key());
  for (const actor of [owner, applicant]) {
    const items = (await market.conversationInbox(actor, {})).items;
    assert.deepEqual(
      new Set(items.map((i) => i.type)),
      new Set(["application", "agreement", "order"]),
    );
    assert.ok(items.some((i) => i.id === agreement.id));
    assert.ok(items.some((i) => i.id === order.id));
  }
  assert.deepEqual((await market.conversationInbox(outsider, {})).items, []);
});
