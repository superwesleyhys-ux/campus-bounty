// Focused P1 regression: mounted authorized viewer + actual fixture revocation.
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { randomUUID: key } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const {
  seedPeople,
  withFixture,
  fixtureSessionLogin,
  origin,
  button,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round8",
  `engineering-roster-reconciliation-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  cases = [],
  errors = [];
let browser, store;
const conv = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const rows = (p) => conv(p).locator("[data-message-id]");
async function count(p, n) {
  await p.waitForFunction(
    (n) => document.querySelectorAll("[data-message-id]").length === n,
    n,
  );
}
async function ready(p) {
  await conv(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
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
  store = createStore(urls);
  const market = createMarket(store);
  const [owner, captain, smallRevoked] = await seedPeople([
    "Reconciliation Publisher",
    "Reconciliation Captain",
    "Reconciliation Removed Small",
  ]);
  const extras = await seedPeople(
    Array.from({ length: 112 }, (_, i) => `Reconciliation Signer ${i + 1}`),
  );
  extras.sort((a, b) => a.id.localeCompare(b.id));
  const largeRevoked = extras[0],
    late = extras.at(-1);
  browser = await chromium.launch({ headless: true });
  for (const large of [false, true]) {
    const label = large ? "partial114" : "complete3";
    const target = large ? largeRevoked : smallRevoked;
    const task = await market.publishTask(
      owner.id,
      {
        title: `Mounted roster ${label} ${run}`,
        category: "Research",
        description: "Synthetic current-roster reconciliation",
        rewardCents: 100,
        milestones: [
          { title: "Review", amountCents: 100, deliverable: "Local evidence" },
        ],
      },
      key(),
    );
    const application = await market.apply(
      captain.id,
      task.id,
      { proposal: "Local reconciliation test" },
      key(),
    );
    await market.inviteApplicant(owner.id, application.id, {}, key());
    const agreement = await market.acceptInvitation(
      captain.id,
      application.id,
      {},
      key(),
    );
    const inserted = large ? extras : [smallRevoked];
    await withFixture((c) =>
      c.query(
        "INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT $1,unnest($2::uuid[])",
        [agreement.id, inserted.map((p) => p.id)],
      ),
    );
    // Keep guard enabled and choose the authorized sender as actor for every INSERT.
    const expected = [];
    for (let n = 1; n <= 120; n++) {
      const author =
        n === 50 || n === 120
          ? target
          : large && (n === 40 || n === 119)
            ? late
            : captain;
      const row = await store.as(
        author.id,
        async (c) =>
          (
            await c.query(
              "INSERT INTO campus.messages(sender_id,agreement_id,body,created_at) VALUES($1,$2,$3,'2026-01-01T00:00:00.123001Z'::timestamptz+$4*interval '1 microsecond') RETURNING id,body",
              [author.id, agreement.id, `${label} immutable body ${n}`, n],
            )
          ).rows[0],
      );
      expected.push({ ...row, author: author.id });
    }
    const p = await (await browser.newContext()).newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await fixtureSessionLogin(p, owner);
    await p.goto(
      `${origin}/?view=workspace&tab=agreements&resource=agreement&id=${agreement.id}`,
    );
    await ready(p);
    await button(p, "Load older messages").click();
    await count(p, 60);
    await button(p, "Load older messages").click();
    await count(p, 90);
    await conv(p)
      .getByLabel("Message", { exact: true })
      .fill(`${label} retained unsent draft`);
    const stamp = key();
    await conv(p).evaluate((e, stamp) => (e.dataset.mountProof = stamp), stamp);
    const before = await rows(p).evaluateAll((es) =>
      es.map((e) => ({
        id: e.dataset.messageId,
        body: e.querySelector("p").textContent,
      })),
    );
    const oldRemoved = expected[49],
      recentRemoved = expected[119];
    assert.match(
      await p.locator(`[data-message-id="${oldRemoved.id}"]`).textContent(),
      new RegExp(target.name),
    );
    if (large) {
      const roster = await market.conversation(owner.id, {
        agreementId: agreement.id,
      });
      assert.equal(
        roster.participants.some((person) => person.id === late.id),
        false,
        "late author really is outside first100",
      );
      assert.equal(
        await conv(p)
          .getByRole("list", { name: "Conversation participants" })
          .locator("li")
          .count(),
        100,
      );
      assert.match(
        await p.locator(`[data-message-id="${expected[39].id}"]`).textContent(),
        new RegExp(late.name),
      );
    }
    await withFixture((c) =>
      c.query(
        "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
        [agreement.id, target.id],
      ),
    );
    await button(p, "Refresh messages").click();
    await ready(p);
    const after = await rows(p).evaluateAll((es) =>
      es.map((e) => ({
        id: e.dataset.messageId,
        body: e.querySelector("p").textContent,
      })),
    );
    const observation = {
      label,
      agreementId: agreement.id,
      mounted: (await conv(p).getAttribute("data-mount-proof")) === stamp,
      beforeCount: before.length,
      afterCount: after.length,
      rosterNames: await conv(p)
        .getByRole("list", { name: "Conversation participants" })
        .innerText(),
      countCopy: await conv(p)
        .getByText(/of \d+ participants shown/)
        .textContent(),
      oldRemovedAuthor: await p
        .locator(`[data-message-id="${oldRemoved.id}"] strong`)
        .textContent(),
      recentRemovedAuthor: await p
        .locator(`[data-message-id="${recentRemoved.id}"] strong`)
        .textContent(),
      lateAuthor: large
        ? await p
            .locator(`[data-message-id="${expected[39].id}"] strong`)
            .textContent()
        : null,
    };
    cases.push(observation);
    await conv(p).screenshot({
      path: path.join(output, `${label}-after-refresh.png`),
    });
    try {
      assert.equal(
        observation.mounted,
        true,
        "same mounted component across real revocation",
      );
      assert.deepEqual(after, before, "all cached bodies and IDs retained");
      assert.doesNotMatch(
        observation.rosterNames,
        new RegExp(target.name),
        "revoked roster identity removed",
      );
      assert.equal(
        observation.countCopy,
        large ? "100 of 113 participants shown." : "2 of 2 participants shown.",
      );
      assert.equal(observation.oldRemovedAuthor, "Author unavailable");
      assert.equal(observation.recentRemovedAuthor, "Author unavailable");
      assert.equal(
        await conv(p).getByLabel("Message", { exact: true }).inputValue(),
        `${label} retained unsent draft`,
      );
      if (large) {
        assert.match(observation.lateAuthor, new RegExp(late.name));
        assert.match(
          await p
            .locator(`[data-message-id="${expected[118].id}"] strong`)
            .textContent(),
          new RegExp(late.name),
        );
        await button(p, "Load more participants").click();
        await conv(p).getByText("113 of 113 participants shown.").waitFor();
        assert.doesNotMatch(
          await conv(p)
            .getByRole("list", { name: "Conversation participants" })
            .innerText(),
          new RegExp(target.name),
        );
      }
      await button(p, "Load older messages").click();
      await count(p, 120);
      const final = await rows(p).evaluateAll((es) =>
        es.map((e) => ({
          id: e.dataset.messageId,
          body: e.querySelector("p").textContent,
        })),
      );
      assert.deepEqual(
        final,
        expected.map(({ id, body }) => ({ id, body })),
        "oldest cursor preserved, all120 bodies reachable once",
      );
      checks.push(label);
      console.log(
        `PASS ${label}: mounted revoke, old+recent authors, current total, no body/draft/cursor loss${large ? ", still-authorized off-page author retained" : ""}`,
      );
    } catch (e) {
      errors.push(`${label}: ${e.stack}`);
      console.error(`${label}: ${e.message}`);
      process.exitCode = 1;
    }
    await p.context().close();
  }
})()
  .catch((e) => {
    errors.push(e.stack);
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (store) await store.close();
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          run,
          checks,
          cases,
          errors,
          proof:
            "Fresh engineering-only real loopback fixtures; mounted publisher remains authorized across actual privileged synthetic signer removal. No response mocking. Role-guarded message INSERTs. Real session verifier excludes email delivery.",
        },
        null,
        2,
      ),
    );
    console.log(`Evidence ${output}`);
  });
