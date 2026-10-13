const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const origin = process.env.CAMPUS_TEST_ORIGIN;
assert.ok(origin?.startsWith("https://"));
(async () => {
  const browser = await chromium.launch();
  try {
    const a = await browser.newContext(),
      b = await browser.newContext();
    const auth = async (context, id) =>
      context.request.post(origin + "/api/auth", {
        headers: { Origin: origin },
        data: { action: "quick", id },
      });
    const call = (context, data, headers = {}) =>
      context.request.post(origin + "/api/action", {
        headers: { Origin: origin, ...headers },
        data,
      });
    assert.equal((await auth(a, "professor")).status(), 200);
    assert.equal((await auth(b, "professor")).status(), 200);
    const cookiesA = await a.cookies(),
      cookiesB = await b.cookies();
    const workspace = (cookies) =>
      cookies.find((cookie) => cookie.name === "__Host-campus_preview");
    assert.notEqual(workspace(cookiesA).value, workspace(cookiesB).value);
    for (const cookie of cookiesA) {
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, "Strict");
    }
    const published = await call(a, {
      action: "publish",
      kind: "task",
      title: "Private cloud isolation check",
      description:
        "This fictional item belongs only to visitor A's demo workspace.",
      category: "Research",
      amount: "25",
      durationDays: 3,
      requirements: "Deliver a test result",
    });
    assert.equal(published.status(), 200);
    const { id } = await published.json();
    const stateA = await (await a.request.get(origin + "/api/state")).json();
    const stateB = await (await b.request.get(origin + "/api/state")).json();
    assert.equal(stateA.preview, true);
    assert.ok(stateA.tasks.some((task) => task.id === id));
    assert.equal(
      stateB.tasks.some((task) => task.id === id),
      false,
    );
    assert.equal((await call(b, { action: "cancel", id })).status(), 404);
    assert.equal(
      (
        await call(
          a,
          { action: "cancel", id },
          { Origin: "https://example.com" },
        )
      ).status(),
      403,
    );
    const large = await a.request.post(origin + "/api/action", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: JSON.stringify({ note: "x".repeat(17000) }),
    });
    assert.equal(large.status(), 413);
    for (const path of [
      "/.env",
      "/.data/campus.db",
      "/package.json",
      "/src/lib/store.mjs",
    ])
      assert.equal((await a.request.get(origin + path)).status(), 404, path);
    const page = await a.newPage();
    await page.goto(origin);
    await page
      .getByRole("heading", { name: /Your campus has ideas/ })
      .waitFor();
    await page.getByText("Cloud preview", { exact: true }).waitFor();
    await page.locator(".task-card").first().waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(
      /\p{Script=Han}/u.test(await page.locator("body").innerText()),
      false,
    );
    await page.screenshot({
      path: "test-results/cloud-preview.png",
      fullPage: false,
    });
    console.log(
      "Cloud HTTPS, Secure cookies, cross-visitor isolation, body limits, private-path protection and English UI PASS",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
