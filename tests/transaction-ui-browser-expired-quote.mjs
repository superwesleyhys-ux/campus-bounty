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
const attempt = process.env.T2C_BROWSER_ATTEMPT || "03";
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

async function ownConsent(p, label, path, actor) {
  const button = p.getByRole("button", { name: label, exact: true });
  await button.locator("..").getByRole("checkbox").check();
  const [r] = await Promise.all([
    p.waitForResponse(
      (r) => r.url().endsWith(path) && r.request().method() === "POST",
    ),
    button.click(),
  ]);
  assert(r.ok());
  const result = await r.json();
  if (actor) assert.equal(result.receipt.userId, actor);
  await record(label, { actor, status: r.status(), receipt: result.receipt });
  await p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  return result;
}
try {
  const suffix = String(Date.now()).slice(-7),
    buyer = await signIn("cancel-buyer-" + suffix),
    seller = await signIn("cancel-seller-" + suffix);
  await seller.p.goto(origin + "/?view=publish&kind=product");
  await seller.p
    .getByLabel("Title", { exact: true })
    .fill("Synthetic used textbook");
  await seller.p
    .getByLabel("Description", { exact: true })
    .fill(
      "Local physical book test with a long title and readable description",
    );
  await seller.p
    .getByLabel("Price per item (USD)", { exact: true })
    .fill("100");
  await seller.p.getByLabel("Available quantity", { exact: true }).fill("2");
  await click(seller.p, "Continue");
  await seller.p.getByLabel("Campus pickup", { exact: true }).check();
  await click(seller.p, "Continue");
  const [published] = await Promise.all([
    seller.p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/products") && r.request().method() === "POST",
    ),
    click(seller.p, "Publish listing"),
  ]);
  assert.equal(published.status(), 201);
  const product = await published.json();
  await buyer.p.goto(
    origin + "/?view=market&resource=product&id=" + product.id,
  );
  await click(buyer.p, "Review total");
  const [reserved] = await Promise.all([
    buyer.p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/orders") && r.request().method() === "POST",
    ),
    click(buyer.p, "Create unpaid reservation"),
  ]);
  assert.equal(reserved.status(), 201);
  const order = await reserved.json(),
    url = origin + "/?view=workspace&tab=orders&resource=order&id=" + order.id;
  await buyer.p.goto(url);
  await click(buyer.p, "Prepare current financial terms");
  await ownConsent(
    buyer.p,
    "Confirm order financial terms",
    `/orders/${order.id}/payment-policy-confirmations`,
    buyer.id,
  );
  await seller.p.goto(url);
  await ownConsent(
    seller.p,
    "Confirm order financial terms",
    `/orders/${order.id}/payment-policy-confirmations`,
    seller.id,
  );
  await buyer.p.reload();
  await click(buyer.p, "Review exact upfront fee reserve");
  const view = await waitFor(async () => {
    const v = await api(buyer.p, `orders/${order.id}/participant-payment`);
    return v.feePlan?.planId ? v : null;
  });
  await ownConsent(
    buyer.p,
    "Confirm my exact fee reserve",
    `/payment-fee-plans/${view.feePlan.planId}/confirmations`,
    buyer.id,
  );
  await seller.p.reload();
  await ownConsent(
    seller.p,
    "Confirm my exact fee reserve",
    `/payment-fee-plans/${view.feePlan.planId}/confirmations`,
    seller.id,
  );
  await buyer.p.reload();
  await click(buyer.p, "Get current payment quote");
  const payment = await waitFor(async () => {
    const v = await api(buyer.p, `orders/${order.id}/participant-payment`);
    return v.quote ? v : null;
  });
  await record("Fresh ordinary order quote before real-time expiry", {
    quote: payment.quote,
    orderId: order.id,
    productId: product.id,
  });
  const waitMs = new Date(payment.quote.expiresAt).getTime() - Date.now() + 300;
  assert(waitMs > 0 && waitMs < 610000);
  const started = Date.now();
  while (Date.now() < new Date(payment.quote.expiresAt).getTime() + 300)
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(
          10000,
          new Date(payment.quote.expiresAt).getTime() + 300 - Date.now(),
        ),
      ),
    );
  await buyer.p.reload();
  await buyer.p
    .getByText(
      "This quote expired. Request and review a current quote before paying.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await buyer.p
      .getByRole("button", { name: "Start payment of $100.00", exact: true })
      .count(),
    0,
  );
  await record("Actually expired quote is visibly unavailable for payment", {
    elapsedMs: Date.now() - started,
    view: await api(buyer.p, `orders/${order.id}/participant-payment`),
  });
  await buyer.p
    .getByRole("button", {
      name: "Review a current payment quote",
      exact: true,
    })
    .focus();
  const [response] = await Promise.all([
    buyer.p.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/payment-quotes"),
    ),
    buyer.p.keyboard.press("Enter"),
  ]);
  const result = await response.json();
  await record("Explicit keyboard re-review creates a fresh quote", {
    status: response.status(),
    result,
  });
  assert.equal(response.status(), 200);
  const fresh = await waitFor(async () => {
    const d = await api(buyer.p, `orders/${order.id}/participant-payment`);
    return d.quote?.quoteId !== payment.quote.quoteId ? d : null;
  });
  assert.equal(fresh.quote.obligationId, payment.quote.obligationId);
  assert.equal(fresh.funding.activeAttempt, null);
  assert.equal(fresh.funding.receivedCents, "0");
  await buyer.p
    .getByRole("button", { name: "Start payment of $100.00", exact: true })
    .waitFor();
  await record("Fresh quote still needs explicit personal payer action", {
    fresh,
  });
  await buyer.p.screenshot({
    path: fileURLToPath(
      new URL(`browser-attempt${attempt}-fresh-quote.png`, evidence),
    ),
    fullPage: true,
  });
  console.log("Real-time quote expiry and explicit re-review passed");
} catch (e) {
  for (const [i, c] of browser.contexts().entries())
    for (const [j, p] of c.pages().entries())
      await p
        .screenshot({
          path: fileURLToPath(
            new URL(`browser-goods-${attempt}-failure-${i}-${j}.png`, evidence),
          ),
          fullPage: true,
        })
        .catch(() => {});
  throw e;
} finally {
  await browser.close();
}
