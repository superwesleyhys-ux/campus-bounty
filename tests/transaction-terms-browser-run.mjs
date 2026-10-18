const { chromium } = await import(
  process.env.T2A_PLAYWRIGHT_MODULE || "playwright"
);
import * as journey from "./transaction-terms-browser.mjs";
const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
try {
  for (const name of (
    process.env.T2A_BROWSER_STEPS ||
    "propose,member,publisher,policy,revise,finish"
  ).split(","))
    console.log(name, await journey[name](page));
} finally {
  await browser.close();
}
