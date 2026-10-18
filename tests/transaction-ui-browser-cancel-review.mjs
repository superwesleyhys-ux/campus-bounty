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
      new URL("browser-attemptunknown01-receipts.json", evidence),
      "utf8",
    ),
  );
  const terminal = {
    order: {
      id: prior.find(
        (v) =>
          v.check === "Visible cancellation with uncertain provider outcome",
      ).cancellation.receipt.orderId,
    },
  };
  const actorId = prior.find((v) =>
    v.check.startsWith("Fresh browser signup"),
  ).actor;
  const files = await fs.readdir(folder);
  const names = await Promise.all(
    files
      .filter((n) => n.startsWith("cancel-buyer-") && n.endsWith(".eml"))
      .map(async (n) => ({
        name: n.slice(0, -4),
        at: (await fs.stat(new URL(n, folder))).mtimeMs,
      })),
  );
  const buyer = await signIn(
    names
      .filter((n) => n.at <= Date.parse(prior[0].at))
      .sort((a, b) => b.at - a.at)[0].name,
  );
  assert.equal(buyer.id, actorId);
  await buyer.p.goto(
    origin +
      "/?view=workspace&tab=orders&resource=order&id=" +
      terminal.order.id,
  );
  await buyer.p
    .getByText(
      "This reservation was cancelled. Check current payment status for any received, late or held funds.",
      { exact: true },
    )
    .waitFor();
  await buyer.p
    .getByRole("heading", { name: "Verified money status", exact: true })
    .waitFor();
  const current = await api(buyer.p, `orders/${terminal.order.id}/payment`);
  assert.equal(current.receivedCents, "0");
  assert.equal(current.activeAttempt, null);
  assert.equal(
    await buyer.p
      .getByRole("heading", { name: "Explicit payer payment", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await buyer.p.getByRole("button", { name: /^Start payment of/ }).count(),
    0,
  );
  await buyer.p
    .getByText("Original quoted requirement", { exact: true })
    .waitFor();
  await buyer.p
    .getByText("Original payment quote history", { exact: true })
    .waitFor();
  await record(
    "Loaded terminal cancelled order continuation without another cancellation",
    {
      payment: current,
      order: await api(buyer.p, `orders/${terminal.order.id}`),
    },
  );
  let messagePosts=0;buyer.p.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/messages'))messagePosts++;});const draft='Unsent synthetic draft survives payment status refresh';await buyer.p.getByLabel('Message',{exact:true}).fill(draft);await click(buyer.p,'Check current payment status');await buyer.p.getByLabel('Message',{exact:true}).waitFor();assert.equal(await buyer.p.getByLabel('Message',{exact:true}).inputValue(),draft);await buyer.p.reload();await buyer.p.getByLabel('Message',{exact:true}).waitFor();assert.equal(await buyer.p.getByLabel('Message',{exact:true}).inputValue(),draft);assert.equal(messagePosts,0);await record('Conversation draft coexists with payment refresh and reload without sending',{messagePosts,draftPreserved:true});await buyer.p.getByRole('heading',{name:'Payment and recipient transfers',exact:true}).scrollIntoViewIfNeeded();
  await buyer.p.screenshot({
    path: fileURLToPath(
      new URL(`browser-attempt${attempt}-loaded-cancelled.png`, evidence),
    ),
    fullPage: true,
  });
  console.log("Loaded cancelled-order capture passed");
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
