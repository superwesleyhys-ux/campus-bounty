// Task 2 engineering: fresh synthetic loopback fixtures + explicit browser faults.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  `engineering-browser-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  audits = [],
  errors = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let store, browser;
const conversation = (p) =>
  p.getByRole("region", { name: "Conversation", exact: true });
const messages = (p) => conversation(p).locator("[data-message-id]");
async function waitCount(p, n) {
  await p.waitForFunction(
    (n) => document.querySelectorAll("[data-message-id]").length === n,
    n,
  );
}
async function ready(p) {
  await conversation(p)
    .getByText("Latest messages checked. Refresh again for new activity.", {
      exact: true,
    })
    .waitFor();
}
async function open(p, type, id) {
  await p.goto(
    `${origin}/?view=workspace&tab=${type === "agreement" ? "agreements" : "orders"}&resource=${type}&id=${id}`,
  );
  await ready(p);
}
async function refresh(p) {
  await button(p, "Refresh messages").click();
  await ready(p);
}
async function api(p, route) {
  return p.evaluate(async (route) => {
    const r = await fetch(`/api/v1/${route}`);
    return { status: r.status, data: await r.json() };
  }, route);
}
async function audit(p, name) {
  await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await p.evaluate(async () =>
    (await axe.run()).violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  );
  const widths = [];
  for (const width of [320, 768, 1024, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    const dim = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    assert.ok(dim.scroll <= dim.width, `${name} overflow ${width}`);
    await p.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
    widths.push(width);
  }
  audits.push({ name, widths, violations });
  assert.deepEqual(violations, [], `${name} axe`);
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
  const people = await seedPeople([
    "Engineer Publisher",
    "Engineer Captain",
    "Engineer <img src=x onerror=alert(1)>",
    "Engineer Later Joiner",
    "Engineer Buyer",
    "Engineer Seller",
  ]);
  const [owner, captain, peer, later, buyer, seller] = people;
  let team = await market.createTeam(
    captain.id,
    {
      name: "Engineering signed team",
      context: {
        purpose: "Local checks",
        activities: "Review local records",
        timeCommitment: "One hour",
        projectContext: "",
      },
    },
    key(),
  );
  team = await market.inviteMember(
    captain.id,
    team.id,
    { userId: peer.id, expectedRevision: team.revision },
    key(),
  );
  team = await market.acceptMembership(
    peer.id,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  const task = await market.publishTask(
    owner.id,
    {
      title: `Engineering stages ${run}`,
      category: "Research",
      description: "Synthetic scoped conversation checks",
      rewardCents: 2000,
      milestones: [1, 2].map((n) => ({
        title: `Engineering stage ${n}`,
        amountCents: 1000,
        deliverable: "A local record",
        acceptanceCriteria: "Include context",
      })),
    },
    key(),
  );
  const app = await market.apply(
    captain.id,
    task.id,
    { teamId: team.id, proposal: "Engineering proposal" },
    key(),
  );
  await market.consentApplication(peer.id, app.id, {}, key());
  await market.inviteApplicant(owner.id, app.id, {}, key());
  const agreement = await market.acceptInvitation(
    captain.id,
    app.id,
    {},
    key(),
  );
  team = await market.leaveTeam(
    peer.id,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  team = await market.inviteMember(
    captain.id,
    team.id,
    { userId: later.id, expectedRevision: team.revision },
    key(),
  );
  await market.acceptMembership(
    later.id,
    team.id,
    { expectedRevision: team.revision },
    key(),
  );
  await withFixture((c) =>
    c.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [
      agreement.id,
    ]),
  );
  // Valid actor + real insert guard/notification trigger. Synthetic timestamps.
  await store.as(peer.id, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,agreement_id,body,created_at) SELECT $1,$2,'Engineering history '||n,'2026-01-01T00:00:00.123001Z'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,106)n",
      [peer.id, agreement.id],
    ),
  );
  const product = await market.publishProduct(
    seller.id,
    {
      title: "Engineering lamp",
      description: "Synthetic no payment",
      priceCents: 100,
      stock: 2,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const quote = await market.quote(
    buyer.id,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order = await market.order(buyer.id, { quoteId: quote.id }, key());
  browser = await chromium.launch({ headless: true });
  const contexts = await Promise.all(people.map(() => browser.newContext()));
  const pages = [];
  for (let i = 0; i < people.length; i++) {
    const p = await contexts[i].newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await fixtureSessionLogin(p, people[i]);
    pages.push(p);
  }
  const [publisher, cap, member, joiner, buying, selling] = pages;
  const privateSeed = path.resolve(
    ".data/qa",
    `round8-engineering-${run}.json`,
  );
  fs.writeFileSync(
    privateSeed,
    JSON.stringify({ people, agreementId: agreement.id, orderId: order.id }),
    { mode: 0o600 },
  );
  await open(member, "agreement", agreement.id);
  await waitCount(member, 30);
  assert.match(await conversation(member).textContent(), /Engineer Publisher/);
  assert.match(await conversation(member).textContent(), /Captain/);
  assert.match(await conversation(member).textContent(), /Signed participant/);
  assert.match(
    await conversation(member).textContent(),
    /Engineer <img src=x onerror=alert\(1\)> · You/,
  );
  assert.equal(await conversation(member).locator("img").count(), 0);
  assert.doesNotMatch(
    await conversation(member).textContent(),
    /Engineer Later Joiner/,
  );
  assert.equal(
    (await api(joiner, `conversations?agreementId=${agreement.id}`)).status,
    404,
  );
  record(
    "Signed departed participant authorized; later joiner excluded; names/roles/You escaped",
  );
  await audit(member, "conversation-recent");
  await button(member, "Load older messages").focus();
  await member.keyboard.press("Enter");
  await waitCount(member, 60);
  assert.equal(
    await button(member, "Load older messages").evaluate(
      (e) => e === document.activeElement,
    ),
    true,
  );
  const list = conversation(member).getByRole("list", {
    name: "Message history",
  });
  await list.evaluate((e) => (e.scrollTop = 250));
  const before = await list.evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
  }));
  await button(member, "Load older messages").click();
  await waitCount(member, 90);
  const after = await list.evaluate((e) => ({
    top: e.scrollTop,
    height: e.scrollHeight,
  }));
  assert.ok(
    Math.abs(after.top - before.top - after.height + before.height) < 3,
    "older scroll retains visible reading position",
  );
  await button(member, "Load older messages").click();
  await waitCount(member, 106);
  await conversation(member)
    .getByText("Beginning of conversation · No older messages.")
    .waitFor();
  assert.equal(
    new Set(
      await messages(member).evaluateAll((es) =>
        es.map((e) => e.dataset.messageId),
      ),
    ).size,
    106,
  );
  record(
    "106 exact history items; repeated older loads complete, deduplicated, scroll and keyboard focus preserved",
  );
  await store.as(owner.id, (c) =>
    c.query(
      "UPDATE campus.users SET display_name='Publisher renamed <b>text</b>' WHERE id=$1",
      [owner.id],
    ),
  );
  await store.as(peer.id, (c) =>
    c.query(
      "INSERT INTO campus.messages(sender_id,agreement_id,body) SELECT $1,$2,'Engineering arrival '||n FROM generate_series(1,65)n",
      [peer.id, agreement.id],
    ),
  );
  await refresh(member);
  await waitCount(member, 171);
  assert.equal(
    new Set(
      await messages(member).evaluateAll((es) =>
        es.map((e) => e.dataset.messageId),
      ),
    ).size,
    171,
  );
  assert.match(
    await conversation(member).textContent(),
    /Publisher renamed <b>text<\/b>/,
  );
  await refresh(member);
  await waitCount(member, 171);
  record(
    "65 new arrivals bridged across >2 pages; refresh preserves older history and current renamed labels",
  );
  const fault = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Engineering injected read outage",
        code: "unavailable",
      }),
    });
  await member.route("**/api/v1/conversations?*", fault);
  await button(member, "Refresh messages").click();
  await member.getByText("Engineering injected read outage").waitFor();
  await waitCount(member, 171);
  await member.unroute("**/api/v1/conversations?*", fault);
  await refresh(member);
  record("Injected history refresh error retains loaded messages and recovers");
  await conversation(member)
    .getByLabel("Message", { exact: true })
    .fill("Engineering persistent draft");
  await member.reload();
  await ready(member);
  assert.equal(
    await conversation(member)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "Engineering persistent draft",
  );
  await member
    .getByRole("link", { name: "Notifications", exact: false })
    .first()
    .click();
  await open(member, "agreement", agreement.id);
  assert.equal(
    await conversation(member)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "Engineering persistent draft",
  );
  record("Unsent draft survives route return and reload");
  const sent = [];
  const lose = async (route) => {
    sent.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  };
  await member.route("**/api/v1/messages", lose);
  await button(member, "Send message").click();
  await member
    .getByRole("heading", { name: "Message outcome not confirmed" })
    .waitFor();
  assert.equal(
    await conversation(member)
      .getByLabel("Message", { exact: true })
      .isDisabled(),
    true,
  );
  await member.unroute("**/api/v1/messages", lose);
  await member.reload();
  await ready(member);
  assert.equal(
    await conversation(member)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "Engineering persistent draft",
  );
  await withFixture((c) =>
    c.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [
      peer.id,
    ]),
  );
  await button(member, "Recover same message").click();
  await member
    .getByText(
      "Conversation unavailable. Your access may have changed. Private messages, participants and drafts are hidden.",
    )
    .waitFor();
  assert.equal(await messages(member).count(), 0);
  assert.equal(
    await conversation(member).getByLabel("Message", { exact: true }).count(),
    0,
  );
  await withFixture((c) =>
    c.query("UPDATE campus.users SET account_status='active' WHERE id=$1", [
      peer.id,
    ]),
  );
  await refresh(member);
  const retry = async (route) => {
    sent.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    await route.continue();
  };
  await member.route("**/api/v1/messages", retry);
  await button(member, "Recover same message").click();
  await member
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
    )
    .waitFor();
  await member.unroute("**/api/v1/messages", retry);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(
    await withFixture(
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int n FROM campus.messages WHERE agreement_id=$1 AND body=$2",
            [agreement.id, "Engineering persistent draft"],
          )
        ).rows[0].n,
    ),
    1,
  );
  record(
    "Real committed send + response-loss injection; reload; real lock hides content; original exact body/key survives and recovers one row",
  );
  await open(buying, "order", order.id);
  await buying
    .getByText("Start the conversation with a question or update.")
    .waitFor();
  assert.match(await conversation(buying).textContent(), /Buyer/);
  assert.match(await conversation(buying).textContent(), /Seller/);
  await audit(buying, "order-empty");
  await conversation(buying)
    .getByLabel("Message", { exact: true })
    .fill("Engineering buyer draft");
  // Same browser tab, different real session and account; no private old draft.
  await fixtureSessionLogin(buying, seller);
  await open(buying, "order", order.id);
  assert.equal(
    await conversation(buying)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "",
  );
  await fixtureSessionLogin(buying, buyer);
  await open(buying, "order", order.id);
  assert.equal(
    await conversation(buying)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "Engineering buyer draft",
  );
  await audit(buying, "order-draft");
  record(
    "Buyer/seller empty state; same-tab real account switch isolates and restores scoped drafts",
  );
  // New browser with storage writes/reads blocked: preserve memory and same key.
  const blocked = await browser.newContext();
  const bp = await blocked.newPage();
  await fixtureSessionLogin(bp, buyer);
  await bp.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw Error("Injected unavailable storage");
    };
    Storage.prototype.setItem = () => {
      throw Error("Injected unavailable storage");
    };
  });
  await open(bp, "order", order.id);
  await conversation(bp)
    .getByText(/Browser storage is unavailable/)
    .waitFor();
  await conversation(bp)
    .getByLabel("Message", { exact: true })
    .fill("Engineering memory recovery");
  const memorySent = [];
  const memoryLose = async (route) => {
    memorySent.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    const res = await route.fetch();
    assert.equal(res.status(), 201);
    await route.abort("failed");
  };
  await bp.route("**/api/v1/messages", memoryLose);
  await button(bp, "Send message").click();
  await bp
    .getByRole("heading", { name: "Message outcome not confirmed" })
    .waitFor();
  await bp.unroute("**/api/v1/messages", memoryLose);
  await bp.getByRole("link", { name: "Workspace", exact: true }).click();
  // Client navigation only (full reload would intentionally lose memory).
  await bp.evaluate((id) => {
    history.pushState(
      null,
      "",
      `/?view=workspace&tab=orders&resource=order&id=${id}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, order.id);
  await ready(bp);
  assert.equal(
    await conversation(bp).getByLabel("Message", { exact: true }).inputValue(),
    "Engineering memory recovery",
  );
  const memoryRetry = async (route) => {
    memorySent.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    await route.continue();
  };
  await bp.route("**/api/v1/messages", memoryRetry);
  await button(bp, "Recover same message").click();
  await bp
    .getByText(
      "Message confirmed. The original request was recovered without sending a duplicate.",
    )
    .waitFor();
  assert.deepEqual(memorySent[0], memorySent[1]);
  record(
    "Injected unavailable storage honestly warned; in-memory exact-key recovery survives client route return",
  );
  await blocked.close();
  // More than 100 synthetic frozen signers (privileged setup only; never current team).
  await withFixture((c) =>
    c.query(
      "WITH p AS (INSERT INTO campus.users(display_name) SELECT 'Engineering extra signer '||n FROM generate_series(1,112)n RETURNING id) INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT $1,id FROM p",
      [agreement.id],
    ),
  );
  await open(member, "agreement", agreement.id);
  assert.equal(
    await conversation(member)
      .getByRole("list", { name: "Conversation participants" })
      .locator("li")
      .count(),
    100,
  );
  await member.route("**/api/v1/conversations/participants?*", fault);
  await button(member, "Load more participants").click();
  await member.getByText("Engineering injected read outage").waitFor();
  assert.equal(
    await conversation(member)
      .getByRole("list", { name: "Conversation participants" })
      .locator("li")
      .count(),
    100,
  );
  await member.unroute("**/api/v1/conversations/participants?*", fault);
  await button(member, "Load more participants").click();
  await conversation(member)
    .getByText("115 of 115 participants shown.")
    .waitFor();
  await waitCount(member, 30);
  await button(member, "Load older messages").click();
  await waitCount(member, 60);
  await audit(member, "large-roster");
  record(
    "115 frozen participants reachable independently of message cursor; roster failure preserves first page and recovers",
  );
  // Work events emitted through real business transitions, then exact notification UI anchors.
  const stages = (await market.agreement(captain.id, agreement.id)).milestones;
  const sub1 = await market.submitMilestone(
    captain.id,
    stages[0].id,
    {
      content: "Engineering v1",
      expectedVersion: stages[0].version,
      expectedRevision: stages[0].revision,
    },
    key(),
  );
  const reviewed = await market.requestMilestoneRevision(
    owner.id,
    stages[0].id,
    {
      submissionId: sub1.submission.id,
      expectedVersion: sub1.milestone.version,
      expectedRevision: sub1.milestone.revision,
      feedback: "Engineering revision",
    },
    key(),
  );
  const sub2 = await market.submitMilestone(
    captain.id,
    stages[0].id,
    {
      content: "Engineering v2",
      expectedVersion: reviewed.milestone.version,
      expectedRevision: reviewed.milestone.revision,
    },
    key(),
  );
  const subOther = await market.submitMilestone(
    captain.id,
    stages[1].id,
    {
      content: "Engineering second stage",
      expectedVersion: stages[1].version,
      expectedRevision: stages[1].revision,
    },
    key(),
  );
  const accepted = await market.acceptMilestone(
    owner.id,
    stages[1].id,
    {
      submissionId: subOther.submission.id,
      expectedVersion: subOther.milestone.version,
      expectedRevision: subOther.milestone.revision,
    },
    key(),
  );
  await withFixture((c) =>
    c.query(
      "SELECT campus.emit_notification($1,'milestone.submitted','agreement',$2,ARRAY[$3]::uuid[],$4)",
      [`engineering-legacy-${run}`, agreement.id, owner.id, captain.id],
    ),
  );
  async function inbox(p) {
    await p.goto(`${origin}/?view=notifications`);
    await p
      .locator('[aria-label="Activity updates"][aria-busy="false"]')
      .waitFor();
  }
  await inbox(publisher);
  let notices = (await api(publisher, "notifications?limit=50")).data;
  const n1 = notices.items.find(
    (n) => n.workContext?.submissionId === sub1.submission.id,
  );
  const n2 = notices.items.find(
    (n) => n.workContext?.submissionId === sub2.submission.id,
  );
  const no = notices.items.find(
    (n) => n.workContext?.submissionId === subOther.submission.id,
  );
  assert.ok(n1 && n2 && no);
  for (const [n, title, version] of [
    [n1, "Engineering stage 1", 1],
    [n2, "Engineering stage 1", 2],
    [no, "Engineering stage 2", 1],
  ]) {
    const card = publisher.locator(`[data-notification-id="${n.id}"]`);
    assert.match(
      await card.textContent(),
      new RegExp(`${title}.*Version ${version}`),
    );
    assert.match(await card.textContent(), new RegExp(task.title));
  }
  const legacy = notices.items.find(
    (n) => n.kind === "milestone.submitted" && !n.workContext,
  );
  assert.ok(legacy);
  assert.equal(
    await publisher
      .locator(`[data-notification-id="${legacy.id}"] .cb-notification-work`)
      .count(),
    0,
  );
  await audit(publisher, "exact-notifications");
  await publisher
    .locator(`[data-notification-id="${n1.id}"]`)
    .getByRole("link", { name: "Open update" })
    .click();
  await publisher.waitForFunction(
    (id) => document.activeElement?.id === `submission-${id}`,
    sub1.submission.id,
  );
  assert.equal(
    await publisher.locator(`#submission-${sub1.submission.id}`).isVisible(),
    true,
  );
  assert.equal(
    await publisher
      .locator(`#submission-${sub1.submission.id}`)
      .locator("xpath=..")
      .getAttribute("open"),
    "",
  );
  assert.ok(
    (await api(publisher, "notifications?limit=50")).data.items.find(
      (n) => n.id === n1.id,
    ).readAt === null,
  );
  record(
    "Exact stage/version cards stay distinct; old submission deep link opens previous versions and focuses exact record without marking read; legacy remains generic",
  );
  await inbox(cap);
  notices = (await api(cap, "notifications?limit=50")).data;
  for (const review of [reviewed, accepted]) {
    const note = notices.items.find(
      (n) => n.navigationAnchor?.reviewId === review.receipt.reviewId,
    );
    assert.ok(note);
    await cap
      .locator(`[data-notification-id="${note.id}"]`)
      .getByRole("link", { name: "Open update" })
      .click();
    await cap.waitForFunction(
      (id) => document.activeElement?.id === `review-${id}`,
      review.receipt.reviewId,
    );
    assert.equal(
      await cap.locator(`#review-${review.receipt.reviewId}`).isVisible(),
      true,
    );
    await inbox(cap);
  }
  record(
    "Revision request and accepted event links focus exact review across two milestones",
  );
  await inbox(publisher);
  await button(publisher, "Unread").click();
  const readCard = publisher.locator(`[data-notification-id="${n1.id}"]`);
  const readLoss = async (route) => {
    const r = await route.fetch();
    assert.equal(r.status(), 200);
    await route.abort("failed");
  };
  await publisher.route(`**/api/v1/notifications/${n1.id}/read`, readLoss);
  await readCard.getByRole("button", { name: "Mark read" }).click();
  await publisher
    .getByRole("heading", { name: "Confirm read status" })
    .waitFor();
  await publisher
    .getByText(
      "Connection interrupted. Your entries are still here. Retry to check or finish this request.",
      { exact: true },
    )
    .waitFor();
  await publisher.unroute(`**/api/v1/notifications/${n1.id}/read`, readLoss);
  await button(publisher, "Retry read request").click();
  await publisher
    .getByText("Marked as read. This does not complete any project action.")
    .waitFor();
  await button(publisher, "All updates").click();
  await publisher
    .locator(`[data-notification-id="${n1.id}"]`)
    .getByText("Read", { exact: true })
    .waitFor();
  record(
    "Unread/all filter and real committed read + response-loss recovery remain correct",
  );
  // Exact scope isolation and a definitive validation failure allow correction.
  const quote2 = await market.quote(
    buyer.id,
    product.id,
    { quantity: 1, deliveryMethod: "pickup" },
    key(),
  );
  const order2 = await market.order(buyer.id, { quoteId: quote2.id }, key());
  await open(buying, "order", order2.id);
  assert.equal(
    await conversation(buying)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "",
  );
  await conversation(buying)
    .getByLabel("Message", { exact: true })
    .fill("Engineering other scope draft");
  await open(buying, "order", order.id);
  assert.equal(
    await conversation(buying)
      .getByLabel("Message", { exact: true })
      .inputValue(),
    "Engineering buyer draft",
  );
  const invalid = (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Engineering injected validation failure",
        code: "invalid_input",
      }),
    });
  await buying.route("**/api/v1/messages", invalid);
  await button(buying, "Send message").click();
  await buying.getByText("Engineering injected validation failure").waitFor();
  assert.equal(
    await conversation(buying)
      .getByLabel("Message", { exact: true })
      .isEnabled(),
    true,
  );
  await buying.unroute("**/api/v1/messages", invalid);
  await conversation(buying)
    .getByLabel("Message", { exact: true })
    .fill("Engineering corrected draft");
  await button(buying, "Send message").click();
  await buying.getByText("Message sent and confirmed.").waitFor();
  await withFixture((c) =>
    c.query(
      "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
      [buyer.id],
    ),
  );
  await refresh(buying);
  assert.equal(await button(buying, "Send message").isDisabled(), true);
  await buying
    .getByText(
      "Sending requires an active account and current campus email verification.",
    )
    .waitFor();
  assert.ok((await messages(buying).count()) > 0);
  await withFixture((c) =>
    c.query(
      "UPDATE campus.affiliations SET valid_until=now()+interval '180 days' WHERE user_id=$1",
      [buyer.id],
    ),
  );
  await refresh(buying);
  record(
    "Same-account order scope drafts isolated; injected definite422 allows correction; real expired membership keeps history and disables sending",
  );
  // Initial and older-page failures expose recovery without dropping a draft/history.
  await selling.route("**/api/v1/conversations?*", fault);
  await selling.goto(
    `${origin}/?view=workspace&tab=orders&resource=order&id=${order.id}`,
  );
  await selling.getByText("Engineering injected read outage").waitFor();
  assert.equal(
    await conversation(selling).getByLabel("Message", { exact: true }).count(),
    0,
  );
  await selling.unroute("**/api/v1/conversations?*", fault);
  await refresh(selling);
  await open(cap, "agreement", agreement.id);
  await conversation(cap)
    .getByLabel("Message", { exact: true })
    .fill("Engineering older-load draft");
  await cap.route("**/api/v1/conversations?*cursor=*", fault);
  await button(cap, "Load older messages").click();
  await cap.getByText("Engineering injected read outage").waitFor();
  await waitCount(cap, 30);
  assert.equal(
    await conversation(cap).getByLabel("Message", { exact: true }).inputValue(),
    "Engineering older-load draft",
  );
  await cap.unroute("**/api/v1/conversations?*cursor=*", fault);
  await button(cap, "Load older messages").click();
  await waitCount(cap, 60);
  record(
    "Injected initial and older-page outages recover; cached message page and draft remain intact",
  );
  // Real revoked signer: persisted notification exists but API removes private detail.
  await withFixture((c) =>
    c.query(
      "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
      [agreement.id, peer.id],
    ),
  );
  await button(member, "Refresh messages").click();
  await member
    .getByText(
      "Conversation unavailable. Your access may have changed. Private messages, participants and drafts are hidden.",
    )
    .waitFor();
  assert.equal(await messages(member).count(), 0);
  await inbox(member);
  assert.equal(await member.locator(".cb-notification-work").count(), 0);
  const unavailable = (
    await api(member, "notifications?limit=20")
  ).data.items.filter((n) => !n.targetAvailable);
  assert.ok(unavailable.length > 0);
  for (const item of unavailable) {
    const card = member.locator(`[data-notification-id="${item.id}"]`);
    assert.equal(
      await card
        .locator(".cb-notification-context, .cb-notification-work")
        .count(),
      0,
    );
    assert.equal(
      await card.getByRole("link", { name: "Open update" }).count(),
      0,
    );
  }
  await open(publisher, "agreement", agreement.id);
  assert.match(
    await conversation(publisher).textContent(),
    /Author unavailable/,
  );
  assert.doesNotMatch(
    await conversation(publisher).textContent(),
    /Engineer <img src=x onerror=alert/,
  );
  record(
    "Real signer permission loss clears roster/messages and all private notification work context",
  );
  assert.deepEqual(errors, [], "No page errors");
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
          audits,
          errors,
          proof:
            "Real synthetic loopback database/API/browser. Explicit response faults and Storage overrides are fault injection; fixture auth uses real verifier, excludes email delivery. No payment/deployment.",
        },
        null,
        2,
      ),
    );
    console.log(`Evidence ${output}`);
  });
