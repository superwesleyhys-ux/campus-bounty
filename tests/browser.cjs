const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await page.goto(process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3010");
    await page
      .getByRole("heading", { name: /Your campus has ideas/ })
      .waitFor({ timeout: 10000 });
    assert.ok(
      await page
        .getByRole("button", { name: "Sign in", exact: true })
        .isVisible(),
    );
    console.log("Campus landing and login entry PASS");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
