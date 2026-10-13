// Narrow Round10 final-fix engineering follow-up. New synthetic actors/scopes
// only; original persona/dogfood fixtures and sealed artifacts are not read.
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
const output = path.resolve(
  ".superpowers/sdd/interaction-round10-plan/final-fix-evidence",
  `browser-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  errors = [],
  observations = [];
const record = (name, details) => {
  checks.push(name);
  if (details) observations.push({ name, ...details });
  console.log(`PASS ${name}`);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const conv = (page) =>
  page.getByRole("region", { name: "Conversation", exact: true });
const history = (page) =>
  conv(page).getByRole("list", { name: "Message history", exact: true });
const ready = (page) =>
  conv(page)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
const geometry = (page, id) =>
  history(page).evaluate((node, id) => {
    const item = Array.from(node.children).find(
      (item) => item.dataset.messageId === id,
    );
    const box = node.getBoundingClientRect(),
      target = item?.getBoundingClientRect();
    return {
      top: node.scrollTop,
      height: node.scrollHeight,
      viewport: node.clientHeight,
      itemTop: target ? target.top - box.top - node.clientTop : null,
      itemBottom: target ? target.bottom - box.top - node.clientTop : null,
      visible:
        !!target &&
        target.top >= box.top - 1 &&
        target.bottom <= box.bottom + 1,
    };
  }, id);
async function assertVisible(page, id) {
  await history(page).waitFor();
  const value = await geometry(page, id);
  assert.ok(
    value.height > value.viewport * 3,
    "Actual message history must overflow substantially",
  );
  assert.ok(
    value.visible,
    `Confirmed message must be in viewport: ${JSON.stringify(value)}`,
  );
  return value;
}
let store, browser;
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  assert.equal(new URL(origin).hostname, "127.0.0.1");
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
  let owner, applicant, discussion, agreement, order, scopes;
  const resumePath = process.env.FINAL_FIX_RESUME_FIXTURE;
  if (resumePath) {
    assert.ok(
      path
        .resolve(resumePath)
        .startsWith(
          path.resolve(
            ".superpowers/sdd/interaction-round10-plan/final-fix-evidence",
          ) + path.sep,
        ),
    );
    const resume = JSON.parse(fs.readFileSync(resumePath));
    assert.equal(resume.database, fixture.database);
    scopes = resume.scopes;
    assert.deepEqual(
      scopes.map(([scope]) => scope),
      ["applicationId", "agreementId", "orderId"],
    );
    [discussion, agreement, order] = scopes.map(([, id]) => ({ id }));
    const ids = resume.people.map((person) =>
      typeof person === "string" ? person : person.id,
    );
    // Only this run's recorded synthetic users; no trial/private fixture input.
    [owner, applicant] = await withFixture(async (client) => {
      const people = await client.query(
        "SELECT u.id,u.display_name AS name,split_part(i.email,'@',1) AS \"emailName\" FROM campus.users u JOIN campus.identities i ON i.user_id=u.id WHERE u.id=ANY($1::uuid[])",
        [ids],
      );
      return ids.map((id) => people.rows.find((person) => person.id === id));
    });
    assert.ok(owner && applicant);
  } else {
    [owner, applicant] = await seedPeople([
      "Final repair publisher",
      "Final repair applicant",
    ]);
    const task = async (label) =>
      market.publishTask(
        owner.id,
        {
          title: `Final repair ${label}`,
          category: "Research",
          description: "Synthetic scoped scroll check; no external commitment",
          rewardCents: 100,
          milestones: [
            {
              title: "Evidence",
              amountCents: 100,
              deliverable: "Local evidence",
            },
          ],
        },
        key(),
      );
    discussion = await market.apply(
      applicant.id,
      (await task("application discussion")).id,
      { proposal: "Fresh engineering follow-up" },
      key(),
    );
    const accepted = await market.apply(
      applicant.id,
      (await task("agreement compatibility")).id,
      { proposal: "Fresh engineering agreement" },
      key(),
    );
    await market.inviteApplicant(owner.id, accepted.id, {}, key());
    agreement = await market.acceptInvitation(
      applicant.id,
      accepted.id,
      {},
      key(),
    );
    const product = await market.publishProduct(
      owner.id,
      {
        title: "Final repair synthetic lamp",
        description: "No payment",
        priceCents: 100,
        stock: 1,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      key(),
    );
    const quote = await market.quote(
      applicant.id,
      product.id,
      { quantity: 1, deliveryMethod: "pickup" },
      key(),
    );
    order = await market.order(applicant.id, { quoteId: quote.id }, key());
    scopes = [
      ["applicationId", discussion.id],
      ["agreementId", agreement.id],
      ["orderId", order.id],
    ];
    for (const [scope, id] of scopes) {
      for (let i = 0; i < 38; i++)
        await market.sendMessage(
          owner.id,
          {
            [scope]: id,
            body: `Final repair history ${i + 1}. Clarification context for reading position.\nSecond line of synthetic engineering context.`,
          },
          key(),
        );
    }
  }
  fs.writeFileSync(
    path.join(output, "fixture-receipt.json"),
    JSON.stringify(
      { database: fixture.database, people: [owner, applicant], scopes },
      null,
      2,
    ),
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.stack));
  page.setDefaultTimeout(20000);
  await fixtureSessionLogin(page, applicant);
  const open = async (resource, id) => {
    const tab =
      resource === "application"
        ? "applications"
        : resource === "agreement"
          ? "agreements"
          : "orders";
    await page.goto(
      `${origin}/?view=workspace&tab=${tab}&resource=${resource}&id=${id}`,
    );
    await ready(page);
  };
  await open("application", discussion.id);
  let gate = null;
  await page.route("**/api/v1/conversations?**", async (route) => {
    const url = new URL(route.request().url());
    if (gate && url.searchParams.get("applicationId") === discussion.id) {
      const current = gate;
      gate = null;
      current.arrived.resolve();
      await current.release.promise;
    }
    await route.continue();
  });
  const posted = [];
  page.on("response", async (response) => {
    if (
      new URL(response.url()).pathname === "/api/v1/messages" &&
      response.request().method() === "POST" &&
      response.ok()
    ) {
      posted.push(await response.json());
    }
  });
  if (!resumePath) {
    await history(page).evaluate((node) => {
      node.scrollTop = 100;
    });
    const firstBody = `Final repair visible confirmed message ${key()}`;
    const held = (gate = { arrived: deferred(), release: deferred() });
    await page.getByLabel("Message", { exact: true }).fill(firstBody);
    await button(page, "Send message").click();
    await Promise.race([
      held.arrived.promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for held history refresh")),
          20000,
        ),
      ),
    ]);
    assert.equal(
      await history(page).count(),
      0,
      "Application private history is hidden while authority refresh waits",
    );
    await button(page, "Sign out").focus();
    held.release.resolve();
    await ready(page);
    const firstReceipt = posted.find((r) => r.body === firstBody);
    assert.ok(firstReceipt?.id);
    const firstGeometry = await assertVisible(page, firstReceipt.id);
    assert.ok(
      await button(page, "Sign out").evaluate(
        (node) => node === document.activeElement,
      ),
      "Reveal must not steal focus from another control",
    );
    await history(page).screenshot({
      path: path.join(output, "01-confirmed-message-visible.png"),
    });
    record(
      "application confirmed send reveals exact message after private busy hiding without stealing focus",
      firstGeometry,
    );
  }
  await history(page).evaluate((node) => {
    node.scrollTop = 180;
  });
  const anchor = await history(page).evaluate((node) => {
    const box = node.getBoundingClientRect();
    const item = Array.from(node.children).find(
      (item) => item.getBoundingClientRect().bottom > box.top + 1,
    );
    return {
      id: item.dataset.messageId,
      offset: item.getBoundingClientRect().top - box.top,
    };
  });
  await button(page, "Load older messages").click();
  await conv(page)
    .getByText("Older messages loaded. Your reading position is preserved.", {
      exact: true,
    })
    .waitFor();
  const anchored = await history(page).evaluate((node, anchor) => {
    const item = Array.from(node.children).find(
      (item) => item.dataset.messageId === anchor.id,
    );
    return {
      offset:
        item.getBoundingClientRect().top - node.getBoundingClientRect().top,
      focused: node === document.activeElement,
    };
  }, anchor);
  assert.ok(
    Math.abs(anchored.offset - anchor.offset) < 2,
    "Prepending older history retains the visible message offset",
  );
  assert.equal(
    anchored.focused,
    true,
    "Exhausted older button returns keyboard focus to history",
  );
  await page
    .getByRole("searchbox", { name: "Search this conversation", exact: true })
    .fill("Clarification context");
  const priorTop = await history(page).evaluate((node) => node.scrollTop);
  await button(page, "Search messages").click();
  await page
    .getByRole("region", { name: "Search results", exact: true })
    .waitFor();
  assert.equal(
    await history(page).evaluate((node) => node.scrollTop),
    priorTop,
    "An ordinary discovery authority update must not jump history to bottom",
  );
  record(
    "older-history anchor and keyboard reading focus preserved; discovery update does not scroll",
    { anchor, anchored, priorTop },
  );

  let lostReceipt, lostKey;
  await page.route(
    "**/api/v1/messages",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      lostKey = route.request().headers()["idempotency-key"];
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      lostReceipt = await response.json();
      await route.abort("failed");
    },
    { times: 1 },
  );
  const recoveryBody = `Final repair lost acknowledgement ${key()}`;
  await page.getByLabel("Message", { exact: true }).fill(recoveryBody);
  await button(page, "Send message").click();
  await conv(page)
    .getByRole("heading", { name: "Message outcome not confirmed" })
    .waitFor();
  await ready(page);
  const storageKey = `campus:conversation:${applicant.id}:applicationId:${discussion.id}`;
  const pending = await page.evaluate(
    (name) => JSON.parse(sessionStorage.getItem(name)),
    storageKey,
  );
  assert.equal(pending.pending.key, lostKey);
  assert.equal(pending.pending.body, recoveryBody);
  // Sequential ordinary messages and withdrawal: no lock, raw insertion or revocation scenario.
  for (let i = 0; i < 4; i++)
    await market.sendMessage(
      owner.id,
      {
        applicationId: discussion.id,
        body: `Later synthetic clarification ${i}`,
      },
      key(),
    );
  await market.withdrawApplication(applicant.id, discussion.id, {}, key());
  await button(page, "Refresh messages").click();
  await ready(page);
  await conv(page)
    .getByRole("heading", { name: "Application discussion is read-only" })
    .waitFor();
  assert.equal(
    (
      await page.evaluate(
        (name) => JSON.parse(sessionStorage.getItem(name)),
        storageKey,
      )
    ).pending.key,
    lostKey,
  );
  record(
    "lost acknowledgement retains exact pending request through ordinary read-only refresh",
  );
  await button(page, "Recover same message").click();
  await ready(page);
  await conv(page)
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
      { exact: true },
    )
    .waitFor();
  const recoveredGeometry = await assertVisible(page, lostReceipt.id);
  const recoveredReceipt = posted.find((r) => r.id === lostReceipt.id);
  assert.ok(recoveredReceipt);
  const rows = await store.as(owner.id, (client) =>
    client.query(
      "SELECT id FROM campus.messages WHERE application_id=$1 AND body=$2",
      [discussion.id, recoveryBody],
    ),
  );
  assert.deepEqual(
    rows.rows.map((r) => r.id),
    [lostReceipt.id],
  );
  const after = await page.evaluate(
    (name) => JSON.parse(sessionStorage.getItem(name)),
    storageKey,
  );
  assert.equal(after.pending, null);
  assert.equal(after.body, "");
  await history(page).screenshot({
    path: path.join(output, "02-recovered-message-visible.png"),
  });
  record(
    "read-only recovery reveals the exact original receipt despite newer messages; one stored message",
    recoveredGeometry,
  );

  for (const [resource, id] of [
    ["agreement", agreement.id],
    ["order", order.id],
  ]) {
    await open(resource, id);
    await history(page).evaluate((node) => {
      node.scrollTop = 200;
    });
    const before = await history(page).evaluate((node) => node.scrollTop);
    const body = `Final repair ${resource} compatibility ${key()}`;
    await page.getByLabel("Message", { exact: true }).fill(body);
    await button(page, "Send message").click();
    await conv(page)
      .getByText("Message sent and confirmed.", { exact: true })
      .waitFor();
    await ready(page);
    assert.equal(
      await history(page).evaluate((node) => node.scrollTop),
      before,
      "Legacy send preserves existing viewport behavior",
    );
    assert.ok(posted.some((r) => r.body === body));
    record(`${resource} confirmed send preserves legacy history position`, {
      before,
    });
  }
  assert.deepEqual(errors, []);
})()
  .catch((error) => {
    errors.push(error.stack);
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (store) await store.close();
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify({ checks, observations, errors }, null, 2),
    );
    console.log(`Evidence: ${output}`);
  });
