// Fresh synthetic identities for isolated UI-only round8 trials. Run only after reviewed012.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  seedPeople,
  fixtureSessionLogin,
  withFixture,
} = require("./team-browser-support.cjs");

(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const folder = path.resolve(".data/qa/round8");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // One attempt only; preserve partial receipts rather than silently creating duplicate trials.
  fs.writeFileSync(
    path.join(folder, "setup-started.json"),
    JSON.stringify({ startedAt: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  await withFixture(async (c) => {
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM campus.schema_migrations WHERE name LIKE '012_%'",
        )
      ).rows[0].n,
      1,
    );
  });
  const people = await seedPeople([
    "Maya Reed",
    "Owen Lee",
    "Sofia Chen",
    "Eli Turner",
    "Nina Park",
  ]);
  fs.writeFileSync(
    path.join(folder, "people.json"),
    JSON.stringify({ people }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  const [captain, owner, member, buyer, seller] = people;
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const fixture = JSON.parse(
    fs.readFileSync(".data/backend/interaction/fixture.json"),
  );
  assert.match(fixture.database, /^campus_test_[a-f0-9]{32}$/);
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => {
      const url = connectionString(localConfig(), role, fixture.database);
      assert.equal(new URL(url).hostname, "127.0.0.1");
      return [role, url];
    }),
  );
  const store = createStore(urls),
    market = createMarket(store);
  let records;
  try {
    let team = await market.createTeam(
      captain.id,
      {
        name: "Book-swap welcome team",
        context: {
          purpose: "Make the campus book swap easy for first-time visitors.",
          activities:
            "Review welcome notes together and prepare a short visitor checklist.",
          timeCommitment: "About one hour each week for two weeks.",
          projectContext:
            "Synthetic local test collaboration with no real work or payment.",
        },
      },
      randomUUID(),
    );
    team = await market.inviteMember(
      captain.id,
      team.id,
      { userId: member.id, expectedRevision: team.revision },
      randomUUID(),
    );
    await market.acceptMembership(
      member.id,
      team.id,
      { expectedRevision: team.revision },
      randomUUID(),
    );
    const task = await market.publishTask(
      owner.id,
      {
        title: "Campus book-swap welcome guide",
        category: "Writing",
        description:
          "A short guide and checklist for first-time book-swap visitors. This is a synthetic local collaboration; funding is simulated and no real work or payment is involved.",
        rewardCents: 12000,
        milestones: [
          {
            title: "Draft guide",
            amountCents: 6000,
            deliverable: "Three practical steps for a first-time visitor.",
            acceptanceCriteria:
              "Include three numbered steps, the meeting location, and a contact point for questions.",
          },
          {
            title: "Final checklist",
            amountCents: 6000,
            deliverable: "A concise preparation checklist.",
            acceptanceCriteria:
              "Include what to bring, how to confirm the time, and what to do if unable to attend.",
          },
        ],
      },
      randomUUID(),
    );
    const app = await market.apply(
      captain.id,
      task.id,
      {
        teamId: team.id,
        proposal:
          "We will prepare the guide and checklist together using the agreed criteria.",
      },
      randomUUID(),
    );
    await market.consentApplication(member.id, app.id, {}, randomUUID());
    await market.inviteApplicant(owner.id, app.id, {}, randomUUID());
    const signed = await market.acceptInvitation(
      captain.id,
      app.id,
      {},
      randomUUID(),
    );
    // Funding is synthetic fixture state, never evidence of payment.
    await withFixture((c) =>
      c.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [
        signed.id,
      ]),
    );
    await market.sendMessage(
      owner.id,
      {
        agreementId: signed.id,
        body: "For the welcome guide, the meeting place is the east entrance of the campus bookstore. Questions go to the student events desk. Please keep these details in our guide.",
      },
      randomUUID(),
    );
    await market.sendMessage(
      member.id,
      {
        agreementId: signed.id,
        body: "I can review the checklist. I will check the preparation items and the cancellation instructions.",
      },
      randomUUID(),
    );
    const planning = [
      "I reviewed the heading and will keep the wording short.",
      "The numbered steps are easier to follow than a long paragraph.",
      "I checked the spelling in the welcome note.",
      "I will keep the guide and preparation checklist as separate deliverables.",
      "The tone should stay friendly and practical for a first-time visitor.",
    ];
    for (let i = 0; i < 103; i++)
      await market.sendMessage(
        (i % 2 ? owner : member).id,
        {
          agreementId: signed.id,
          body: `Planning note ${i + 1}: ${planning[i % planning.length]}`,
        },
        randomUUID(),
      );
    await market.sendMessage(
      owner.id,
      {
        agreementId: signed.id,
        body: "We have discussed a lot since our first notes. Before replying, please confirm the meeting place we agreed at the beginning and tell us who will review the checklist.",
      },
      randomUUID(),
    );
    const view = await market.agreement(captain.id, signed.id);
    const [first, second] = view.milestones;
    const submitted = await market.submitMilestone(
      captain.id,
      first.id,
      {
        content:
          "1. Go to the campus bookstore.\n2. Check the welcome table.\n3. Follow the book-swap signs.",
        expectedVersion: first.version,
        expectedRevision: first.revision,
      },
      randomUUID(),
    );
    await market.requestMilestoneRevision(
      owner.id,
      first.id,
      {
        submissionId: submitted.submission.id,
        expectedVersion: submitted.milestone.version,
        expectedRevision: submitted.milestone.revision,
        feedback:
          "Please include the exact meeting place and contact point from our early discussion. These are already in the agreed acceptance criteria.",
      },
      randomUUID(),
    );
    const revised = (
      await market.agreement(captain.id, signed.id)
    ).milestones.find((m) => m.id === first.id);
    await market.submitMilestone(
      captain.id,
      first.id,
      {
        content:
          "1. Meet at the east entrance of the campus bookstore.\n2. Check the welcome table and follow the book-swap signs.\n3. Ask the student events desk if you have questions.",
        expectedVersion: revised.version,
        expectedRevision: revised.revision,
      },
      randomUUID(),
    );
    await market.submitMilestone(
      member.id,
      second.id,
      {
        content:
          "Bring the books you want to swap. Confirm the event time with the student events desk before leaving. Tell the student events desk if you cannot attend.",
        expectedVersion: second.version,
        expectedRevision: second.revision,
      },
      randomUUID(),
    );
    const product = await market.publishProduct(
      seller.id,
      {
        title: "Adjustable study desk lamp",
        description:
          "Synthetic local listing for a used desk lamp. No real purchase, collection, or payment.",
        priceCents: 1800,
        stock: 1,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      randomUUID(),
    );
    const quote = await market.quote(
      buyer.id,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      randomUUID(),
    );
    const order = await market.order(
      buyer.id,
      { quoteId: quote.id },
      randomUUID(),
    );
    await market.sendMessage(
      seller.id,
      {
        orderId: order.id,
        body: "The lamp includes its power cable. The separate book stand in the photo is not included. The proposed pickup place is the north lobby of the student center.",
      },
      randomUUID(),
    );
    await market.sendMessage(
      buyer.id,
      {
        orderId: order.id,
        body: "Thanks. I will check the included items and proposed pickup place again before confirming anything.",
      },
      randomUUID(),
    );
    for (let i = 0; i < 103; i++)
      await market.sendMessage(
        (i % 2 ? buyer : seller).id,
        {
          orderId: order.id,
          body: `Lamp discussion ${i + 1}: ${i % 2 ? "I am checking my study setup; no pickup time is confirmed." : "The lamp is still set aside in this local test; no payment has been made."}`,
        },
        randomUUID(),
      );
    await market.sendMessage(
      seller.id,
      {
        orderId: order.id,
        body: "Please look back at what is included and the proposed pickup place, then let me know whether those details work for you. We have not agreed a pickup time.",
      },
      randomUUID(),
    );
    records = {
      agreement: {
        id: signed.id,
        title: task.title,
        teamId: team.id,
        milestoneIds: view.milestones.map((m) => m.id),
      },
      order: { id: order.id, title: product.title },
      messageCounts: { agreement: 106, order: 106 },
    };
    fs.writeFileSync(
      path.join(folder, "records.json"),
      JSON.stringify(records, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await store.close();
  }
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [person, file] of [
      [captain, "persona.state.json"],
      [buyer, "dogfood-buyer.state.json"],
      [seller, "dogfood-seller.state.json"],
    ]) {
      const context = await browser.newContext();
      try {
        await fixtureSessionLogin(await context.newPage(), person);
        await context.storageState({ path: path.join(folder, file) });
        fs.chmodSync(path.join(folder, file), 0o600);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    "Prepared fresh isolated conversation sessions: three signed collaborators, buyer/seller, 106 messages per scope, two stages and multiple versions. Funding simulated; OTP delivery, payment and external messaging excluded.",
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
