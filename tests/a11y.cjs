const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const origin = process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3010";
  const reports = [];
  async function check(name) {
    await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
    const result = await page.evaluate(() =>
      axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
        },
      }),
    );
    reports.push({
      name,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    });
  }
  try {
    await page.goto(origin);
    await page.locator(".task-card").first().waitFor();
    await check("home-desktop");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await check("login");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("button", { name: "Browse market", exact: true })
      .click();
    await check("market-desktop");
    await page.setViewportSize({ width: 320, height: 800 });
    await check("market-mobile-320");
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("button", { name: "Bounties", exact: true })
      .click();
    await check("home-mobile-320");
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync(
      "test-results/accessibility.json",
      JSON.stringify(reports, null, 2),
    );
    console.log(
      JSON.stringify(
        reports.map((r) => ({
          name: r.name,
          violations: r.violations.map((v) => ({
            id: v.id,
            count: v.nodes.length,
            nodes: v.nodes.slice(0, 7),
          })),
        })),
        null,
        2,
      ),
    );
    assert.equal(
      reports.flatMap((r) => r.violations).length,
      0,
      "automated accessibility findings",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
