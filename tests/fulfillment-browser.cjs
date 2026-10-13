// Round 6: actual fulfillment UI on a disposable loopback fixture. Auth and funding are setup, not payment/OTP E2E.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  origin,
  button,
  seedPeople,
  withFixture,
  fixtureSessionLogin,
} = require("./team-browser-support.cjs");
const run = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  "docs/evidence/interaction-round6",
  `browser-fulfillment-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  visualChecks = [],
  pageErrors = [],
  pages = [];
const record = (name) => {
  checks.push(name);
  console.log(`PASS: ${name}`);
};
const panel = (p, n) =>
  p
    .locator(".cb-fulfillment-milestone")
    .filter({ has: p.getByRole("heading", { name: new RegExp(`^${n}\\. `) }) });
async function api(p, route, body) {
  return p.evaluate(
    async ({ route, body, key }) => {
      const r = await fetch(
        `/api/v1/${route}`,
        body !== undefined
          ? {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": key,
              },
              body: JSON.stringify(body),
            }
          : { cache: "no-store" },
      );
      const data = await r.json();
      if (!r.ok) throw Error(`${r.status} ${data.detail}`);
      return data;
    },
    { route, body, key: randomUUID() },
  );
}
async function open(p, id) {
  await p.goto(
    `${origin}/?view=workspace&id=${id}&resource=agreement&tab=agreements`,
  );
  await p.locator(".cb-fulfillment-milestone").first().waitFor();
  await button(panel(p, 1), "Refresh milestone").waitFor();
  await p.waitForFunction(
    () =>
      !document
        .querySelector(".cb-fulfillment-milestone")
        ?.textContent.includes("Loading milestone and review history"),
  );
}
async function refresh(p, n) {
  await button(panel(p, n), "Refresh milestone").click();
  await panel(p, n)
    .getByText(
      "Latest version and review history refreshed. Review them before continuing.",
      { exact: true },
    )
    .waitFor();
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
    const size = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    assert.ok(size.scroll <= size.width, `${name} overflow at ${width}`);
    await p.screenshot({
      path: path.join(output, `${name}-${width}.png`),
      fullPage: true,
    });
    widths.push(width);
  }
  visualChecks.push({ name, widths, violations });
  assert.equal(violations.length, 0, JSON.stringify(violations));
}
async function loseNextResponse(page, endpoint) {
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const handler = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("failed");
    resolve();
  };
  await page.route(endpoint, handler);
  return async () => {
    await done;
    await page.unroute(endpoint, handler);
  };
}
async function setup(owner, member) {
  const task = await api(owner, "tasks", {
    title: `Fulfillment ${run}`,
    category: "Research",
    description: "Compare two campus study spaces using the agreed rubric.",
    rewardCents: 2000,
    milestones: [
      {
        title: "Research summary",
        amountCents: 1000,
        deliverable: "A summary with two cited campus spaces.",
        acceptanceCriteria:
          "Both spaces have opening hours and accessible entrance details.",
      },
      {
        title: "Final comparison",
        amountCents: 1000,
        deliverable: "One comparison table with recommendations.",
        acceptanceCriteria:
          "The table includes noise, opening hours, and entrance access.",
      },
    ],
  });
  const application = await api(member, `tasks/${task.id}/applications`, {
    proposal: "I will compare the two spaces and cite the campus listings.",
  });
  await api(owner, `applications/${application.id}/invitation`, {});
  return api(member, `applications/${application.id}/acceptance`, {});
}
(async () => {
  assert.equal(
    process.env.CAMPUS_CONTEXT_FIXTURE_AUTH,
    "1",
    "Explicit synthetic session fixture opt-in required",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const people = await seedPeople([
      "Fulfillment publisher",
      "Fulfillment contributor",
    ]);
    for (const person of people) {
      const p = await (await browser.newContext()).newPage();
      p.on("pageerror", (e) => pageErrors.push(e.message));
      await fixtureSessionLogin(p, person);
      pages.push(p);
    }
    const [owner, member] = pages;
    const agreement = await setup(owner, member);
    await open(member, agreement.id);
    assert.equal(
      await button(panel(member, 1), "Submit for review").isDisabled(),
      true,
    );
    await member.getByText("Waiting for funding", { exact: true }).waitFor();
    await withFixture((c) =>
      c.query(
        "UPDATE campus.agreements SET state='active' WHERE id=$1 AND owner_id=$2 AND state='awaiting_funding'",
        [agreement.id, people[0].id],
      ),
    );
    await open(member, agreement.id);
    record(
      "Signed agreement enforces funding gate; only this synthetic agreement is activated as a fixture, no payment performed",
    );
    let a = await api(owner, `agreements/${agreement.id}`);
    const [m1, m2] = a.milestones;
    const first = panel(member, 1),
      second = panel(member, 2);
    await first
      .getByLabel("Your deliverable", { exact: true })
      .fill(
        "Version one: Library and study hall; opening hours need verification.",
      );
    await member.reload();
    await first.getByLabel("Your deliverable", { exact: true }).waitFor();
    assert.match(
      await first.getByLabel("Your deliverable", { exact: true }).inputValue(),
      /Version one/,
    );
    const submitted = [];
    member.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/milestones/${m1.id}/submissions`)
      )
        submitted.push({
          key: r.headers()["idempotency-key"],
          body: r.postDataJSON(),
        });
    });
    let lostDone;
    const lost = new Promise((resolve) => (lostDone = resolve));
    const endpoint = `**/api/v1/milestones/${m1.id}/submissions`;
    const lose = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      await route.abort("failed");
      lostDone();
    };
    await member.route(endpoint, lose);
    await button(first, "Submit for review").dblclick();
    await button(first, "Retry same request").waitFor();
    await lost;
    await member.unroute(endpoint, lose);
    assert.equal(
      await first
        .getByLabel("Revised deliverable", { exact: true })
        .isDisabled(),
      true,
    );
    await member.reload();
    await button(first, "Retry same request").click();
    await first.getByText(/Your earlier submission was confirmed\./).waitFor();
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0].key, submitted[1].key);
    assert.deepEqual(submitted[0].body, submitted[1].body);
    assert.equal(
      (await api(member, `milestones/${m1.id}/submissions`)).length,
      1,
    );
    record(
      "Draft survives reload; double-click sends once and committed response loss freezes editing and reload retries the same body/key with exactly one submission",
    );
    await first
      .getByLabel("Revised deliverable", { exact: true })
      .fill(
        "Version two: verified hours and accessible entrances for both spaces.",
      );
    await open(owner, agreement.id);
    const ownerFirst = panel(owner, 1);
    const feedback =
      "Add verified opening hours and accessible entrance details for each space, as required by the acceptance criteria.";
    await ownerFirst
      .getByLabel("Changes needed", { exact: true })
      .fill(feedback);
    const reviewRequests = [];
    owner.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/milestones/${m1.id}/revision-requests`)
      )
        reviewRequests.push({
          key: r.headers()["idempotency-key"],
          body: r.postDataJSON(),
        });
    });
    const finishLostReview = await loseNextResponse(
      owner,
      `**/api/v1/milestones/${m1.id}/revision-requests`,
    );
    await button(ownerFirst, "Request changes to version 1").click();
    await button(ownerFirst, "Retry same request").waitFor();
    await finishLostReview();
    await ownerFirst
      .getByRole("heading", {
        name: "Changes requested · Version 1",
        exact: true,
      })
      .waitFor();
    await button(first, "Submit new version").click();
    await first.locator(".cb-error[role=alert]").waitFor();
    assert.match(
      await first
        .getByLabel("Revised deliverable", { exact: true })
        .inputValue(),
      /Version two/,
    );
    await button(first, "Keep draft and review latest version").waitFor();
    assert.equal(
      await first
        .locator(".cb-fulfillment-feedback")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    const focusBounds = await first
      .locator(".cb-fulfillment-feedback")
      .evaluate((e) => ({
        top: e.getBoundingClientRect().top,
        bottom: e.getBoundingClientRect().bottom,
        height: innerHeight,
      }));
    assert.ok(
      focusBounds.top >= 0 &&
        focusBounds.top < focusBounds.height &&
        focusBounds.bottom > 0,
      "Conflict focus is visible",
    );
    await first.getByText(feedback, { exact: true }).waitFor();
    record(
      "Publisher records specific immutable version feedback; stale same-version contributor draft is blocked and preserved with conflict focus",
    );
    await button(first, "Keep draft and review latest version").focus();
    await member.keyboard.press("Enter");
    await button(first, "Submit new version").click();
    await first
      .getByRole("heading", {
        name: "Latest submission · Version 2",
        exact: true,
      })
      .waitFor();
    await owner.reload();
    await button(ownerFirst, "Retry same request").click();
    await ownerFirst
      .getByText(/Your earlier change request was confirmed\./)
      .waitFor();
    await ownerFirst
      .getByRole("heading", {
        name: "Latest submission · Version 2",
        exact: true,
      })
      .waitFor();
    assert.equal(reviewRequests.length, 2);
    assert.deepEqual(reviewRequests[0], reviewRequests[1]);
    assert.equal((await api(owner, `milestones/${m1.id}/reviews`)).length, 1);
    record(
      "Lost change-request response survives reload; same-key receipt confirms the original review while the UI displays the contributor’s newer version",
    );
    await ownerFirst.getByRole("checkbox").check();
    const tab = await member.context().newPage();
    tab.on("pageerror", (e) => pageErrors.push(e.message));
    pages.push(tab);
    await open(tab, agreement.id);
    await panel(tab, 1)
      .getByLabel("Revised deliverable", { exact: true })
      .fill("Version three: final verified citations and access notes.");
    await button(panel(tab, 1), "Submit new version").click();
    await panel(tab, 1)
      .getByRole("heading", {
        name: "Latest submission · Version 3",
        exact: true,
      })
      .waitFor();
    await button(ownerFirst, "Accept version 2").click();
    await ownerFirst.locator(".cb-error[role=alert]").waitFor();
    await ownerFirst
      .getByRole("heading", {
        name: "Latest submission · Version 3",
        exact: true,
      })
      .waitFor();
    assert.equal(await ownerFirst.getByRole("checkbox").isChecked(), false);
    assert.equal(
      await button(ownerFirst, "Accept version 3").isDisabled(),
      true,
    );
    record(
      "Cross-tab newer submission rejects stale acceptance and requires explicit review of the new version",
    );
    await ownerFirst.getByRole("checkbox").check();
    await button(ownerFirst, "Accept version 3").click();
    await ownerFirst
      .getByRole("heading", { name: "Accepted · Version 3", exact: true })
      .waitFor();
    assert.equal(
      (await api(owner, `agreements/${agreement.id}`)).state,
      "active",
    );
    await ownerFirst
      .getByText("Previous versions (2)", { exact: true })
      .click();
    await ownerFirst.getByText(feedback, { exact: true }).waitFor();
    record(
      "Acceptance binds the exact submitted version, preserves earlier feedback, and leaves agreement active while another milestone is open",
    );
    await refresh(member, 2);
    await second
      .getByLabel("Your deliverable", { exact: true })
      .fill(
        "Comparison table version one: noise and hours, entrance access pending.",
      );
    await button(second, "Submit for review").click();
    await second
      .getByRole("heading", {
        name: "Latest submission · Version 1",
        exact: true,
      })
      .waitFor();
    await refresh(owner, 2);
    let raced = false;
    const raceRoute = `**/api/v1/milestones/${m2.id}/reviews`;
    await member.route(
      raceRoute,
      async (route) => {
        const old = await route.fetch();
        if (!raced) {
          raced = true;
          const latest = (
            await api(owner, `agreements/${agreement.id}`)
          ).milestones.find((m) => m.id === m2.id);
          await api(owner, `milestones/${m2.id}/revision-requests`, {
            submissionId: latest.latest_submission_id,
            expectedVersion: latest.version,
            expectedRevision: latest.revision,
            feedback:
              "Add entrance access to the comparison table, required by the agreed criteria.",
          });
        }
        await route.fulfill({ response: old });
      },
      { times: 1 },
    );
    await button(second, "Refresh milestone").click();
    await second
      .getByText(
        "The milestone changed while loading. Refresh to review its latest version.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await button(second, "Submit new version").isDisabled(), true);
    await member.unroute(raceRoute);
    await refresh(member, 2);
    await second
      .getByText(
        "Add entrance access to the comparison table, required by the agreed criteria.",
        { exact: true },
      )
      .waitFor();
    record(
      "Concurrent same-version review during aggregate reads is detected; mixed review/milestone data cannot enable submission",
    );
    await audit(member, "feedback-and-history");
    await second
      .getByLabel("Revised deliverable", { exact: true })
      .fill(
        "Comparison table version two: noise, verified hours and entrance access for both spaces.",
      );
    await button(second, "Submit new version").click();
    await second
      .getByRole("heading", {
        name: "Latest submission · Version 2",
        exact: true,
      })
      .waitFor();
    await refresh(owner, 2);
    await panel(owner, 2).getByRole("checkbox").check();
    const acceptanceRequests = [];
    owner.on("request", (r) => {
      if (
        r.method() === "POST" &&
        r.url().endsWith(`/milestones/${m2.id}/acceptance`)
      )
        acceptanceRequests.push(r.headers()["idempotency-key"]);
    });
    const finishLostAcceptance = await loseNextResponse(
      owner,
      `**/api/v1/milestones/${m2.id}/acceptance`,
    );
    await button(panel(owner, 2), "Accept version 2").click();
    await button(panel(owner, 2), "Retry same request").waitFor();
    await finishLostAcceptance();
    await owner.reload();
    await button(panel(owner, 2), "Retry same request").click();
    await panel(owner, 2)
      .getByText(/Your earlier acceptance was confirmed\./)
      .waitFor();
    assert.equal(acceptanceRequests.length, 2);
    assert.equal(acceptanceRequests[0], acceptanceRequests[1]);
    await owner
      .getByText(/Agreement completed: every milestone has been accepted/)
      .waitFor();
    a = await api(owner, `agreements/${agreement.id}`);
    assert.equal(a.state, "completed");
    assert.ok(
      a.milestones.every(
        (m) => m.state === "accepted" && m.accepted_submission_id,
      ),
    );
    const reviews = await api(owner, `milestones/${m2.id}/reviews`);
    assert.deepEqual(
      reviews.map((r) => r.decision),
      ["revision_requested", "accepted"],
    );
    record(
      "Final exact-version acceptance completes the agreement, records immutable review history and explicitly transfers no funds",
    );
    await audit(owner, "completed-agreement");
    await withFixture((c) =>
      c.query(
        "UPDATE campus.agreements SET state='active' WHERE id=$1 AND owner_id=$2 AND state='completed'",
        [agreement.id, people[0].id],
      ),
    );
    await open(owner, agreement.id);
    await button(owner, "Finish agreement").click();
    await owner
      .getByText(/Completion recorded\. The current agreement is completed/)
      .waitFor();
    assert.equal(
      (await api(owner, `agreements/${agreement.id}`)).state,
      "completed",
    );
    record(
      "Synthetic legacy active/all-accepted agreement can be explicitly finished without payment or settlement",
    );
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          visualChecks,
          pageErrors,
          scope:
            "Fresh isolated synthetic accounts. Auth uses actual verifier with synthetic challenge; OTP delivery excluded. Funding activation and legacy active state are bounded synthetic fixture setup; no financial transactions.",
        },
        null,
        2,
      ),
    );
    console.log(output);
  } catch (error) {
    fs.writeFileSync(
      path.join(output, "failure.json"),
      JSON.stringify(
        { passed: false, error: error.stack, checks, visualChecks, pageErrors },
        null,
        2,
      ),
    );
    for (const [i, p] of pages.entries())
      await p
        .screenshot({
          path: path.join(output, `failure-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
