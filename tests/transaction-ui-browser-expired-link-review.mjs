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
const attempt = process.env.T2C_BROWSER_ATTEMPT || "account01";
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
async function signIn(name, existing) {
  const c =
    existing ??
    (await browser.newContext({ viewport: { width: 1440, height: 1000 } }));
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
  if (await p.getByLabel("Your display name", { exact: true }).count())
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
try {
  const prior = JSON.parse(
    await fs.readFile(
      new URL("browser-attemptexpired01-receipts.json", evidence),
      "utf8",
    ),
  );
  const renewed = prior.find(
    (v) =>
      v.check ===
      "Renewed own hosted operation and safe requirements remain distinct from bank payout",
  ).renewed;
  const names = (await fs.readdir(folder)).filter(
    (n) => n.startsWith("renew-own-") && n.endsWith(".eml"),
  );
  const name = names.find((n) => {
    const delta =
      (Date.parse(prior[0].at) % 10000000) -
      Number(n.slice(0, -4).split("-").at(-1));
    return delta >= 0 && delta < 10000;
  });
  assert(name);
  const actor = await signIn(name.slice(0, -4));
  assert.equal(actor.id, prior[0].actor);
  const expired = await api(actor.p, "me/payment-account");
  assert.equal(expired.operation.operationId, renewed.operation.operationId);
  assert.equal(expired.operation.hostedUrl, null);
  await actor.p.goto(origin + "/?view=account");
  await actor.p
    .getByRole("button", {
      name: "Request or renew hosted onboarding",
      exact: true,
    })
    .waitFor();
  await actor.p
    .getByRole("button", { name: "Continue my hosted onboarding", exact: true })
    .waitFor({ state: "hidden" });
  await record(
    "Same own link is expired by actual elapsed time and absent from loaded UI",
    { expired, previous: renewed.operation },
  );
  const [response] = await Promise.all([
    actor.p.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/onboarding"),
    ),
    click(actor.p, "Request or renew hosted onboarding"),
  ]);
  await record("Explicit own renewal after expired link", {
    status: response.status(),
    request: response.request().postDataJSON(),
    receipt: await response.json(),
  });
  assert.equal(response.status(), 200);
  const fresh = await waitFor(async () => {
    const d = await api(actor.p, "me/payment-account");
    return d.operation?.hostedUrl &&
      d.operation.operationId !== expired.operation.operationId
      ? d
      : null;
  });
  await click(actor.p, "Check current payment status");
  await actor.p
    .getByRole("button", { name: "Continue my hosted onboarding", exact: true })
    .waitFor();
  await record("New own hosted operation after actual local expiry", { fresh });
  await actor.p.screenshot({
    path: fileURLToPath(
      new URL(`browser-attempt${attempt}-renewed-expired.png`, evidence),
    ),
  });
  console.log("Same expired-link continuation and explicit renewal passed");
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
