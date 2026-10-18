import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const { chromium } = await import(
  process.env.T2C_PLAYWRIGHT_MODULE ||
    "/Users/huangyusen/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs"
);
const origin = "http://127.0.0.1:3024",
  evidence = new URL(
    "../.superpowers/sdd/transaction-integration-plan/task-2c-evidence/",
    import.meta.url,
  ),
  folder = new URL("../.data/backend/transaction-ui/", import.meta.url);
const attempt = process.env.T2C_BROWSER_ATTEMPT || "amendment01";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks = [];
async function record(check, extra = {}) {
  checks.push({
    at: new Date().toISOString(),
    check,
    ...structuredClone(extra),
  });
  await fs.writeFile(
    new URL(`browser-attempt${attempt}-receipts.json`, evidence),
    JSON.stringify(checks, null, 2),
  );
}
async function waitFor(fn) {
  let lastError;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(
    "Timed out waiting for ordinary flow" +
      (lastError ? ": " + lastError.message : ""),
    { cause: lastError },
  );
}
async function api(p, path, body) {
  const r =
    body === undefined
      ? await p.request.get(origin + "/api/v1/" + path)
      : await p.request.post(origin + "/api/v1/" + path, {
          data: body,
          headers: { Origin: origin, "Idempotency-Key": randomUUID() },
        });
  const d = await r.json();
  assert(r.ok(), `${path}: ${r.status()} ${d.code ?? ""}`);
  return d;
}
async function signIn(name) {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await c.route("https://checkout.stripe.com/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const r = await c.request.get("http://127.0.0.1:3034/pay/" + id);
    await route.fulfill({ response: r });
  });
  await c.route("https://connect.stripe.com/**", async (route) => {
    const r = await c.request.get("http://127.0.0.1:3034/onboard");
    await route.fulfill({ response: r });
  });
  const p = await c.newPage();
  p.setDefaultTimeout(20000);
  await p.goto(origin);
  await p
    .getByLabel("University email", { exact: true })
    .fill(name + "@transaction.example.test");
  const requestedAt = Date.now();
  await p
    .getByRole("button", { name: "Email me a sign-in code", exact: true })
    .click();
  await p.getByLabel("Sign-in code", { exact: true }).waitFor();
  const code = await waitFor(async () => {
    const file = new URL(name + ".eml", folder);
    if ((await fs.stat(file)).mtimeMs < requestedAt) return null;
    const s = await fs.readFile(file, "utf8");
    return s.match(/verification code is (\d{6})/)?.[1];
  });
  await p.getByLabel("Sign-in code", { exact: true }).fill(code);
  await p
    .getByLabel("Your display name", { exact: true })
    .fill("Synthetic " + name);
  const [verified] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/auth/sessions") &&
        r.request().method() === "POST",
    ),
    p.getByRole("button", { name: "Verify and continue", exact: true }).click(),
  ]);
  assert.equal(verified.status(), 200, "ordinary verification response");
  const me = await waitFor(() => api(p, "me"));
  await record(
    "Fresh browser signup through email challenge, local SMTP sink and ordinary auth verification",
    { actor: me.id, synthetic: true },
  );
  if (!me.can_apply) {
    const rr = await c.request.post("http://127.0.0.1:3034/review", {
      data: { userId: me.id },
    });
    assert(rr.ok(), "Local ordinary eligibility review: " + rr.status());
  }
  return { c, p, id: me.id };
}
async function click(p, name) {
  await p.getByRole("button", { name, exact: true }).click();
}
async function confirm(p, label) {
  const button = p.getByRole("button", { name: label, exact: true });
  const field = button.locator("..");
  await field.getByRole("checkbox").check();
  if (label.startsWith("Confirm")) {
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.url().includes("/confirmations") && r.request().method() === "POST",
      ),
      button.click(),
    ]);
    const body = await res.json();
    await record("Personal visible consent response", {
      actor: (await api(p, "me")).id,
      status: res.status(),
      body,
    });
    assert.equal(res.status(), 200);
    assert.equal(body.receipt.userId, (await api(p, "me")).id);
    await waitFor(async () => {
      const d = await api(
        p,
        new URL(res.url()).pathname
          .slice("/api/v1/".length)
          .replace(
            /payment-fee-plans\/.+\/confirmations/,
            "agreements/" + currentAgreement + "/fee-plans",
          ),
      );
      return d.confirmedParticipantIds?.includes(body.receipt.userId);
    });
  } else await button.click();
}
let currentAgreement;
async function openFees(p) {
  const d = p.locator("details").filter({
    has: p.getByText("Processing fee changes and supplemental reserve", {
      exact: true,
    }),
  });
  if (!(await d.evaluate((e) => e.open)))
    await d.locator(":scope > summary").click();
  return d;
}
async function consent(p, label) {
  const b = p.getByRole("button", { name: label, exact: true });
  await b.locator("..").getByRole("checkbox").check();
  const [r] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/confirmations$|\/payment-attempts$/.test(r.url()),
    ),
    b.click(),
  ]);
  const body = await r.json();
  assert(r.ok());
  await record(label, {
    actor: (await api(p, "me")).id,
    status: r.status(),
    body,
  });
  await p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  return body;
}
try {
  const prior = JSON.parse(
    await fs.readFile(
      new URL("browser-attemptfee05-receipts.json", evidence),
      "utf8",
    ),
  );
  const signup = prior.filter((v) =>
    v.check.startsWith("Fresh browser signup"),
  );
  const base = prior.find(
    (v) =>
      v.check ===
      "Funded base created through ordinary authenticated HTTP services",
  );
  const files = await fs.readdir(folder);
  const names = await Promise.all(
    files
      .filter((n) => n.startsWith("fee-recipient-") && n.endsWith(".eml"))
      .map(async (n) => ({
        name: n.slice(0, -4),
        at: (await fs.stat(new URL(n, folder))).mtimeMs,
      })),
  );
  const payer = await signIn(names.sort((a, b) => b.at - a.at)[0].name);
  assert.equal(payer.id, signup[1].actor);
  const gid = base.agreementId,
    url =
      origin + "/?view=workspace&tab=agreements&resource=agreement&id=" + gid;
  await payer.p.goto(url);
  await openFees(payer.p);
  await payer.p
    .getByText(
      "Current fee review: settled. A new proposal does not authorize automatic collection.",
      { exact: true },
    )
    .waitFor();
  await record("Settled fee panel fully loaded before visual checks", {
    view: await api(payer.p, `agreements/${gid}/participant-payment`),
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await payer.p.setViewportSize({ width, height: 1000 });
    assert(
      await payer.p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await payer.p
      .getByText("Processing fee changes and supplemental reserve", {
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await payer.p.screenshot({
      path: fileURLToPath(
        new URL(`browser-attempt${attempt}-settled-fee-${width}.png`, evidence),
      ),
    });
  }
  await payer.p.addScriptTag({
    path: fileURLToPath(
      new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    ),
  });
  const scan = await payer.p.evaluate(async () => {
    const r = await window.axe.run(document.querySelector("main"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    }));
  });
  await record("Expanded settled fee accessibility scan", { violations: scan });
  assert.equal(scan.length, 0);
  let moneyPosts = 0;
  payer.p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/")) moneyPosts++;
  });
  let fail = true;
  await payer.c.route(
    "**/api/v1/funding-obligations/*/fee-revisions",
    async (route) => {
      if (fail && route.request().method() === "GET") {
        fail = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "synthetic_read_unavailable",
            detail:
              "Synthetic status read unavailable; retry the status check.",
          }),
        });
      } else await route.continue();
    },
  );
  await click(payer.p, "Refresh fee evidence");
  await payer.p
    .getByText("Synthetic status read unavailable; retry the status check.", {
      exact: true,
    })
    .waitFor();
  assert(
    await payer.p
      .locator("details")
      .filter({
        has: payer.p.getByText(
          "Processing fee changes and supplemental reserve",
          { exact: true },
        ),
      })
      .evaluate((e) => e.open),
  );
  await record(
    "Scoped synthetic read failure stays visible inside expanded fee section",
    { observedPostRequests: moneyPosts },
  );
  await click(payer.p, "Refresh fee evidence");
  await payer.p
    .getByText(
      "Current fee review: settled. A new proposal does not authorize automatic collection.",
      { exact: true },
    )
    .waitFor();
  assert.equal(moneyPosts, 0);
  await record("Visible scoped retry restores real current fee read", {
    observedPostRequests: moneyPosts,
    view: await api(payer.p, `agreements/${gid}/participant-payment`),
  });
  console.log(
    "Settled fee responsive/accessibility/read-error-retry checks passed",
  );
} catch (e) {
  for (const [i, c] of browser.contexts().entries())
    for (const [j, p] of c.pages().entries())
      await p
        .screenshot({
          path: fileURLToPath(
            new URL(
              `browser-attempt${attempt}-failure-${i}-${j}.png`,
              evidence,
            ),
          ),
          fullPage: true,
        })
        .catch(() => {});
  throw e;
} finally {
  await browser.close();
}
