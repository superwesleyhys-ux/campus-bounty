// Targeted Round 6 copy readback; no changes to signed terms or backend behavior.
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
  `browser-fulfillment-copy-${run}`,
);
fs.mkdirSync(output, { recursive: true });
const checks = [],
  pageErrors = [],
  pages = [];
const record = (check) => {
  checks.push(check);
  console.log(`PASS: ${check}`);
};
async function api(p, route, body) {
  return p.evaluate(
    async ({ route, body, key }) => {
      const r = await fetch(
        `/api/v1/${route}`,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": key,
              },
              body: JSON.stringify(body),
            },
      );
      const data = await r.json();
      if (!r.ok) throw Error(`${r.status}: ${data.detail}`);
      return data;
    },
    { route, body, key: randomUUID() },
  );
}
async function open(p, id) {
  await p.goto(
    `${origin}/?view=workspace&id=${id}&resource=agreement&tab=agreements`,
  );
  await p.locator(".cb-fulfillment-milestone").waitFor();
  await p.waitForFunction(
    () =>
      !document
        .querySelector(".cb-fulfillment-milestone")
        ?.textContent.includes("Loading milestone and review history"),
  );
}
async function refresh(p) {
  await button(p, "Refresh milestone").click();
  await p
    .getByText(
      "Latest version and review history refreshed. Review them before continuing.",
      { exact: true },
    )
    .waitFor();
}
async function checkNoCriteria(p) {
  const form = p.locator(".cb-review-form");
  await form.waitFor();
  assert.doesNotMatch(await form.innerText(), /acceptance criteria/i);
  await form
    .getByRole("checkbox", {
      name: "I have reviewed version 1 against the agreed deliverable.",
      exact: true,
    })
    .waitFor();
  assert.match(
    await form.innerText(),
    /Review version 1 against the agreed deliverable\./,
  );
  assert.match(await form.innerText(), /relates to the agreed deliverable\./);
  await p.getByText(/Not specified in this listing\./).waitFor();
}
(async () => {
  assert.equal(process.env.CAMPUS_CONTEXT_FIXTURE_AUTH, "1");
  const browser = await chromium.launch({ headless: true });
  try {
    const people = await seedPeople([
      "Copy review publisher",
      "Copy review contributor",
    ]);
    for (const person of people) {
      const page = await (
        await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      ).newPage();
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await fixtureSessionLogin(page, person);
      pages.push(page);
    }
    const [owner, member] = pages;
    const task = await api(owner, "tasks", {
      title: `Legacy review wording ${run}`,
      category: "Writing",
      description: "Prepare the agreed plain-language campus guide.",
      rewardCents: 1000,
      milestones: [
        {
          title: "Campus guide",
          amountCents: 1000,
          deliverable: "A short guide explaining two campus study spaces.",
          acceptanceCriteria: null,
        },
      ],
    });
    const application = await api(member, `tasks/${task.id}/applications`, {
      proposal: "I will write a short guide using the campus directory.",
    });
    await api(owner, `applications/${application.id}/invitation`, {});
    const agreement = await api(
      member,
      `applications/${application.id}/acceptance`,
      {},
    );
    const originalTerms = (await api(member, `agreements/${agreement.id}`))
      .terms;
    await withFixture((c) =>
      c.query(
        "UPDATE campus.agreements SET state='active' WHERE id=$1 AND owner_id=$2 AND state='awaiting_funding'",
        [agreement.id, people[0].id],
      ),
    );
    await open(member, agreement.id);
    await member
      .getByText("1 signed collaborator (publisher not included) · 1 milestone", { exact: true })
      .waitFor();
    record("A one-person, one-milestone agreement uses singular labels");
    await member
      .getByLabel("Your deliverable", { exact: true })
      .fill(
        "First guide: two campus study spaces, with one unclear location description.",
      );
    await button(member, "Submit for review").click();
    await member
      .getByText("Version 1 submitted for review.", { exact: true })
      .waitFor();
    await member
      .getByText(
        "Waiting for the publisher to review version 1. You can submit a new version until this milestone is accepted.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await member
        .getByLabel("Revised deliverable", { exact: true })
        .isEnabled(),
      true,
    );
    assert.doesNotMatch(
      await member.locator(".cb-fulfillment-feedback").innerText(),
      /earlier request|earlier submission/i,
    );
    record(
      "Fresh submission has a natural success message and explains waiting for publisher review while revision remains possible",
    );
    await open(owner, agreement.id);
    await checkNoCriteria(owner);
    await owner.screenshot({
      path: path.join(output, "legacy-null-criteria-1440.png"),
      fullPage: true,
    });
    record(
      "Legacy null criteria: review instruction, feedback help and checkbox refer only to the agreed deliverable",
    );
    const route = `**/api/v1/agreements/${agreement.id}`;
    await owner.route(route, async (r) => {
      const response = await r.fetch();
      const data = await response.json();
      data.milestones = data.milestones.map((m) => ({
        ...m,
        acceptance_criteria: "   ",
      }));
      await r.fulfill({ response, json: data });
    });
    await refresh(owner);
    await checkNoCriteria(owner);
    await owner.setViewportSize({ width: 320, height: 950 });
    assert.ok(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await owner.screenshot({
      path: path.join(output, "legacy-blank-criteria-320.png"),
      fullPage: true,
    });
    await owner.unroute(route);
    await refresh(owner);
    assert.deepEqual(
      (await api(owner, `agreements/${agreement.id}`)).terms,
      originalTerms,
    );
    record(
      "Whitespace-only criteria GET fixture has the same accurate wording; signed terms remain byte-equivalent as JSON and no terms are edited",
    );
    await owner
      .getByLabel("Changes needed", { exact: true })
      .fill(
        "Clarify the location of the second study space in the agreed guide.",
      );
    await button(owner, "Request changes to version 1").click();
    await owner
      .getByText("Changes requested for version 1.", { exact: true })
      .waitFor();
    assert.doesNotMatch(
      await owner.locator(".cb-fulfillment-feedback").innerText(),
      /earlier/i,
    );
    await refresh(member);
    await member
      .getByLabel("Revised deliverable", { exact: true })
      .fill("Revised guide: two campus study spaces with clear locations.");
    await button(member, "Submit new version").click();
    await member
      .getByText("Version 2 submitted for review.", { exact: true })
      .waitFor();
    await refresh(owner);
    await owner
      .getByRole("checkbox", {
        name: "I have reviewed version 2 against the agreed deliverable.",
        exact: true,
      })
      .check();
    await button(owner, "Accept version 2").click();
    await owner
      .getByText(
        "Version 2 accepted. The agreement is completed. No funds were transferred.",
        { exact: true },
      )
      .waitFor();
    assert.doesNotMatch(
      await owner.locator(".cb-fulfillment-feedback").innerText(),
      /earlier/i,
    );
    assert.deepEqual(
      (await api(owner, `agreements/${agreement.id}`)).terms,
      originalTerms,
    );
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.screenshot({
      path: path.join(output, "fresh-acceptance-1440.png"),
      fullPage: true,
    });
    record(
      "Fresh change request and acceptance use direct success messages, preserve original terms, and retain the no-transfer boundary",
    );
    assert.deepEqual(pageErrors, []);
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          passed: true,
          checks,
          pageErrors,
          scope:
            "Five copy readback checks; null criteria from real signed synthetic agreement, blank criteria simulated only in intercepted GET responses; no signed terms changed. Isolated synthetic auth excludes OTP delivery; funding is fixture-only. Existing recovery messages separately validated by fulfillment-browser.cjs.",
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
        { passed: false, error: error.stack, checks, pageErrors },
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
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
