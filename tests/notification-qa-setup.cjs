// Synthetic sessions and agreements for isolated UI-only skill tests.
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
  const folder = path.resolve(".data/qa/round7");
  assert.ok(
    !fs.existsSync(path.join(folder, "people.json")),
    "Preserve previous test identities",
  );
  await withFixture(async (c) => {
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM campus.schema_migrations WHERE name LIKE '011_%'",
        )
      ).rows[0].n,
      1,
    );
  });
  const people = await seedPeople([
    "Clara Evans",
    "Amelia Brooks",
    "Daniel Kim",
    "Casey Morgan",
  ]);
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
    market = createMarket(store),
    agreements = [];
  try {
    for (const [owner, assignee, title, revise] of [
      [people[1], people[0], "Study room visitor guide", true],
      [people[2], people[3], "Campus garden orientation notes", false],
    ]) {
      const task = await market.publishTask(
        owner.id,
        {
          title,
          category: "Writing",
          description:
            "A synthetic local collaboration for reviewing a short campus guide. This preview uses test identities and simulated funding; no real work, payment, or external messages are involved.",
          rewardCents: 12000,
          milestones: [
            {
              title: "Draft guide",
              amountCents: 6000,
              deliverable:
                "A short guide describing three practical steps for a first-time visitor.",
              acceptanceCriteria:
                "Include three numbered steps, the meeting location, and a contact point for questions. Use plain language.",
            },
            {
              title: "Final checklist",
              amountCents: 6000,
              deliverable:
                "A concise checklist that a visitor can use before leaving home.",
              acceptanceCriteria:
                "Include what to bring, how to confirm the time, and what to do if the visitor cannot attend.",
            },
          ],
        },
        randomUUID(),
      );
      const application = await market.apply(
        assignee.id,
        task.id,
        {
          proposal:
            "I will draft a practical guide and checklist using the agreed criteria.",
        },
        randomUUID(),
      );
      await market.inviteApplicant(owner.id, application.id, {}, randomUUID());
      const signed = await market.acceptInvitation(
        assignee.id,
        application.id,
        {},
        randomUUID(),
      );
      // Owner connection is confined to the disposable database; this is not a payment.
      await withFixture((c) =>
        c.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [
          signed.id,
        ]),
      );
      const view = await market.agreement(assignee.id, signed.id),
        first = view.milestones[0];
      const submitted = await market.submitMilestone(
        assignee.id,
        first.id,
        {
          content: revise
            ? "1. Enter through the main library doors.\n2. Follow the signs toward the information desk.\n3. Ask at the desk for directions to your booked room."
            : "1. Meet at the campus garden gate.\n2. Check the notice board for your assigned bed.\n3. Ask a volunteer which tools are available.",
          expectedVersion: first.version,
          expectedRevision: first.revision,
        },
        randomUUID(),
      );
      if (revise) {
        await market.requestMilestoneRevision(
          owner.id,
          first.id,
          {
            submissionId: submitted.submission.id,
            expectedVersion: submitted.milestone.version,
            expectedRevision: submitted.milestone.revision,
            feedback:
              "Please name the meeting location as the main library information desk and add the campus library help desk as the contact point for questions. Keep the three numbered steps; these details are already part of the agreed criteria.",
          },
          randomUUID(),
        );
      }
      await market.sendMessage(
        owner.id,
        {
          agreementId: signed.id,
          body: "For our local test collaboration, please check the latest project updates and the original requirements before continuing. No real payment or outside work is involved.",
        },
        randomUUID(),
      );
      // A separate synthetic project makes notification context meaningful.
      const other = await market.publishTask(
        owner.id,
        {
          title: revise
            ? "Study group noticeboard copy"
            : "Garden open-day flyer",
          category: "Writing",
          description:
            "Separate local test project; not part of the existing guide agreement.",
          rewardCents: 3500,
          milestones: [
            {
              title: "Proofread flyer",
              amountCents: 3500,
              deliverable: "A concise proofreading note.",
              acceptanceCriteria:
                "Identify spelling errors and unclear meeting details.",
            },
          ],
        },
        randomUUID(),
      );
      const otherApplication = await market.apply(
        assignee.id,
        other.id,
        { proposal: "I can proofread the short campus flyer." },
        randomUUID(),
      );
      await market.inviteApplicant(
        owner.id,
        otherApplication.id,
        {},
        randomUUID(),
      );
      agreements.push({
        id: signed.id,
        title,
        ownerId: owner.id,
        assigneeId: assignee.id,
      });
    }
  } finally {
    await store.close();
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(folder, "people.json"),
    JSON.stringify({ people, agreements }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [index, filename] of [
      [0, "persona.state.json"],
      [2, "dogfood-publisher.state.json"],
      [3, "dogfood-participant.state.json"],
    ]) {
      const context = await browser.newContext();
      try {
        await fixtureSessionLogin(await context.newPage(), people[index]);
        await context.storageState({ path: path.join(folder, filename) });
        fs.chmodSync(path.join(folder, filename), 0o600);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    "Prepared isolated synthetic notification sessions; funding simulated in disposable DB, OTP delivery excluded, no payment or external email.",
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
