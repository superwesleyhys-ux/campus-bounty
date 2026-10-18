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
  const suffix = String(Date.now()).slice(-7),
    originalName = "switch-original-" + suffix,
    first = await signIn(originalName);
  await first.p.goto(origin + "/?view=account");
  await click(first.p, "Prepare my recipient account");
  await waitFor(
    async () =>
      (await api(first.p, "me/payment-account")).configurationBlocker === null,
  );
  await first.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  let lost = false;
  const requests = [];
  await first.c.route(
    "**/api/v1/me/payment-account/onboarding",
    async (route) => {
      const req = route.request();
      requests.push({
        path: new URL(req.url()).pathname,
        key: req.headers()["idempotency-key"],
        body: req.postDataJSON(),
      });
      if (!lost) {
        lost = true;
        const response = await route.fetch();
        await record("Recipient request response lost", {
          status: response.status(),
          body: await response.json(),
        });
        assert.equal(response.status(), 200);
        await route.abort("failed");
      } else await route.continue();
    },
  );
  await click(first.p, "Create my recipient account");
  await first.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor();
  const saved = await first.p.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([k]) =>
        k.startsWith("campus:money:"),
      ),
    ),
  );
  await record("Original account unknown intent saved", {
    actor: first.id,
    saved,
  });
  const otherTab = await first.c.newPage();
  await otherTab.goto(origin + "/?view=account");
  await click(otherTab, "Sign out");
  await first.p.getByLabel("University email", { exact: true }).waitFor();
  assert.equal(
    await first.p
      .getByRole("heading", { name: "Your payment account", exact: true })
      .count(),
    0,
  );
  await record(
    "Logout clears rendered private payment state in the other tab",
    { originalActor: first.id },
  );
  const other = await signIn("switch-other-" + suffix, first.c);
  await other.p.goto(origin + "/?view=account");
  assert.equal(
    await other.p
      .getByRole("button", { name: "Recover the same request", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    await other.p.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([k]) =>
          k.startsWith("campus:money:"),
        ),
      ),
    ),
    saved,
  );
  await record(
    "Different account cannot view or recover original private intent",
    {
      actor: other.id,
      account: await api(other.p, "me/payment-account"),
      originalIntentPreserved: true,
    },
  );
  await click(other.p, "Sign out");
  const returned = await signIn(originalName, first.c);
  assert.equal(returned.id, first.id);
  await returned.p.goto(origin + "/?view=account");
  await click(returned.p, "Recover the same request");
  await returned.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  await record(
    "Original account recovers the same recipient operation after account switch",
    {
      actor: returned.id,
      requests,
      account: await api(returned.p, "me/payment-account"),
    },
  );
  console.log("Account switch and own recipient recovery passed");
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
