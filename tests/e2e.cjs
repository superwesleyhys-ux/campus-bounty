const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const origin = process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3011";
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [],
    external = [];
  const pages = [];
  let sharedPreviewCookies = [];
  async function makePage() {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    if (sharedPreviewCookies.length)
      await context.addCookies(sharedPreviewCookies);
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) => {
      if (
        !route
          .request()
          .url()
          .startsWith(origin + "/") &&
        !route.request().url().startsWith("data:")
      ) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin);
    await page
      .getByRole("heading", { name: /Your campus has ideas/ })
      .waitFor();
    await page.locator(".task-card").first().waitFor();
    return page;
  }
  async function login(page, name) {
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: new RegExp(name) })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  async function close(page) {
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  async function openTask(page, title) {
    await page.reload();
    await page.getByRole("button", { name: title, exact: true }).click();
  }
  try {
    const prof = await makePage();
    await prof.getByRole("button", { name: "Research", exact: true }).click();
    assert.equal(await prof.locator(".task-card").count(), 2);
    await prof
      .getByLabel("Search bounties or items")
      .fill("no-such-keyword-abc");
    await prof.getByText("No matching bounties", { exact: true }).waitFor();
    await prof.getByRole("button", { name: "Clear search" }).click();
    await prof
      .getByRole("button", { name: "All bounties", exact: true })
      .click();
    await login(prof, "Professor Chen");
    if (process.env.CAMPUS_TEST_SHARED_PREVIEW === "1") {
      sharedPreviewCookies = (await prof.context().cookies()).filter(
        (cookie) => cookie.name === "__Host-campus_preview",
      );
      assert.equal(
        sharedPreviewCookies.length,
        1,
        "cloud E2E participants share only their explicit test workspace",
      );
    }
    await prof.locator(".publish-top").click();
    const title = "Browser acceptance bounty " + Date.now();
    const dlg = prof.getByRole("dialog");
    await dlg.getByLabel("Bounty title").fill(title);
    await dlg.getByLabel("Bounty reward").fill("175.50");
    await dlg
      .getByLabel("Task description")
      .fill(
        "Clean a public campus dataset and deliver working scripts and test results.",
      );
    await dlg
      .getByLabel("Deliverables & acceptance criteria")
      .fill("Deliver working scripts\nDeliver test results");
    await dlg.getByLabel("I have the right to post this content").check();
    await dlg.getByRole("button", { name: "Post bounty", exact: true }).click();
    await prof
      .getByRole("dialog")
      .getByRole("heading", { name: title, exact: true })
      .waitFor();
    assert.ok(
      await prof
        .getByRole("dialog")
        .getByText("$175.50", { exact: false })
        .count(),
    );
    await close(prof);
    const student = await makePage();
    await login(student, "Jamie Lin");
    await openTask(student, title);
    await student
      .getByLabel("Your approach & relevant experience")
      .fill(
        "I know Python and public data processing and can deliver on time.",
      );
    await student
      .getByRole("button", { name: "Submit application", exact: true })
      .click();
    await student
      .getByText(
        "Application submitted. Waiting for the publisher to choose.",
        { exact: false },
      )
      .waitFor();
    await close(student);
    await openTask(prof, title);
    await prof
      .getByRole("button", { name: "Invite applicant", exact: true })
      .click();
    await prof
      .getByRole("dialog")
      .getByText(/Invitation sent\. Waiting for/)
      .waitFor();
    await close(prof);
    await openTask(student, title);
    await student
      .getByRole("button", { name: "Accept task", exact: true })
      .click();
    await student
      .getByLabel("Delivery notes")
      .fill("Scripts and tests are complete. A public demo link is included.");
    await student
      .getByLabel("Deliverable link")
      .fill("https://example.com/delivery");
    await student
      .getByRole("button", { name: "Submit work", exact: true })
      .click();
    await student
      .getByText("Work submitted. Waiting for the publisher to review.")
      .waitFor();
    await close(student);
    await openTask(prof, title);
    await prof.getByLabel("I have checked all acceptance criteria").check();
    await prof
      .getByRole("button", { name: "Approve work", exact: true })
      .click();
    await prof
      .getByText(
        "Task complete. The demo reward status is recorded; no money was transferred.",
      )
      .waitFor();
    await close(prof);
    const maker = await makePage();
    await login(maker, "Taylor Zhou");
    await maker.locator(".publish-top").click();
    await maker
      .getByRole("dialog")
      .getByRole("button", { name: /Sell an item/ })
      .click();
    const good = "Browser acceptance tablet " + Date.now();
    await maker.getByLabel("Item name").fill(good);
    await maker.getByLabel("Item price").fill("88");
    await maker
      .getByLabel("Item description")
      .fill(
        "A demo drawing tablet in working condition with the original pen.",
      );
    await maker
      .getByLabel("Delivery method")
      .fill("Meet outside the campus library");
    await maker.getByLabel("I have the right to post this content").check();
    await maker
      .getByRole("dialog")
      .getByRole("button", { name: "List item", exact: true })
      .click();
    await maker
      .getByRole("dialog")
      .getByRole("heading", { name: good, exact: true })
      .waitFor();
    await close(maker);
    await student.reload();
    await student
      .getByRole("button", { name: "Browse market", exact: true })
      .click();
    await student.getByRole("button", { name: good, exact: true }).click();
    await student
      .getByRole("button", { name: "Place demo order", exact: true })
      .click();
    await student
      .getByText(
        "Waiting for delivery. Switch to the seller demo account to continue.",
      )
      .waitFor();
    await close(student);
    await maker.reload();
    await maker
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("button", { name: /My workspace/ })
      .click();
    await maker.getByRole("button", { name: "Orders", exact: true }).click();
    await maker.getByRole("button", { name: new RegExp(good) }).click();
    await maker
      .getByLabel("Delivery arrangements or digital access instructions")
      .fill(
        "The tablet and pen have been delivered at the agreed location. Please confirm.",
      );
    await maker
      .getByRole("button", { name: "Record delivery", exact: true })
      .click();
    await maker.getByText("Awaiting receipt", { exact: true }).waitFor();
    await close(maker);
    await student.reload();
    await student
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("button", { name: /My workspace/ })
      .click();
    await student.getByRole("button", { name: "Orders", exact: true }).click();
    await student.getByRole("button", { name: new RegExp(good) }).click();
    await student
      .getByRole("button", { name: "Confirm receipt", exact: true })
      .click();
    await student.getByText("Order complete", { exact: true }).waitFor();
    await close(student);
    const guest = await makePage();
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await guest.getByLabel("U.S. university email").fill("outsider@gmail.com");
    await guest.getByRole("button", { name: "Get demo code" }).click();
    await guest.getByRole("alert").waitFor();
    assert.equal(
      await guest.getByLabel("U.S. university email").inputValue(),
      "outsider@gmail.com",
      "validation error must retain entered address",
    );
    await close(guest);
    await guest.getByRole("button", { name: "Sign in", exact: true }).click();
    await guest.keyboard.press("Escape");
    assert.equal(
      await guest
        .getByRole("button", { name: "Sign in", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
      "dialog focus returns to trigger",
    );
    fs.mkdirSync("test-results", { recursive: true });
    await guest.screenshot({
      path: "test-results/home-desktop.png",
      fullPage: true,
    });
    await guest
      .getByRole("button", { name: "Browse market", exact: true })
      .click();
    await guest.screenshot({
      path: "test-results/market-desktop.png",
      fullPage: true,
    });
    for (const width of [320, 390, 768, 1440]) {
      await guest.setViewportSize({ width, height: 900 });
      assert.equal(
        await guest.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `No overflow at ${width}`,
      );
    }
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({
      path: "test-results/market-mobile.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      JSON.stringify({
        status: "PASS",
        task: "publish → apply → invite → accept → submit → approve",
        goods: "publish → order → deliver → received",
        isolation: "three browser contexts",
        viewportWidths: [320, 390, 768, 1440],
        externalRequests: external.length,
        pageErrors: errors,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
