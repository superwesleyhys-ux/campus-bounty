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
let currentAgreement;
try {
  const suffix = String(Date.now()).slice(-7),
    payer = await signIn("payer-" + suffix),
    recipient = await signIn("recipient-" + suffix);
  await recipient.p.goto(origin + "/?view=account");
  await recipient.p
    .getByRole("heading", { name: "Your payment account", exact: true })
    .waitFor();
  await click(recipient.p, "Prepare my recipient account");
  await waitFor(
    async () =>
      !(await recipient.p
        .getByRole("button", {
          name: "Prepare my recipient account",
          exact: true,
        })
        .isDisabled()),
  );
  await click(recipient.p, "Create my recipient account");
  await waitFor(async () => {
    await click(recipient.p, "Check current payment status");
    return (
      (await api(recipient.p, "me/payment-account")).transferCapability ===
      "active"
    );
  });
  const [onboardingResponse] = await Promise.all([
    recipient.p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/me/payment-account/onboarding") &&
        r.request().method() === "POST",
    ),
    click(recipient.p, "Request or renew hosted onboarding"),
  ]);
  await record("Onboarding request response", {
    status: onboardingResponse.status(),
    request: onboardingResponse.request().postDataJSON(),
    body: await onboardingResponse.json(),
  });
  assert.equal(onboardingResponse.status(), 200);
  await waitFor(async () => {
    await click(recipient.p, "Check current payment status");
    return await recipient.p
      .getByRole("button", {
        name: "Continue my hosted onboarding",
        exact: true,
      })
      .count();
  });
  await click(recipient.p, "Continue my hosted onboarding");
  await recipient.p
    .getByRole("heading", { name: "Synthetic local onboarding test" })
    .waitFor();
  await recipient.p
    .getByRole("link", {
      name: "Return to account and refresh provider status",
    })
    .click();
  await record(
    "New auth-created identity prepared recipient and reached synthetic hosted onboarding",
    {
      actor: recipient.id,
      account: await api(recipient.p, "me/payment-account"),
    },
  );
  await payer.p.goto(origin + "/?view=publish&kind=task");
  await payer.p
    .getByLabel("Title", { exact: true })
    .fill("Task2C visible browser bounty");
  await payer.p
    .getByLabel("Description", { exact: true })
    .fill("Synthetic local participant journey");
  await payer.p
    .getByLabel("Total bounty reward (USD)", { exact: true })
    .fill("100");
  await payer.p
    .getByLabel("Target delivery date", { exact: true })
    .fill("2027-01-01");
  await click(payer.p, "Continue");
  await payer.p
    .getByLabel("After each accepted milestone", { exact: true })
    .check();
  await payer.p.getByLabel("Milestone title", { exact: true }).fill("Report");
  await payer.p
    .getByLabel("Expected deliverable", { exact: true })
    .fill("Written report");
  await payer.p
    .getByLabel("Acceptance criteria", { exact: true })
    .fill("Report addresses the agreed question");
  await payer.p
    .getByLabel("Milestone reward (USD)", { exact: true })
    .fill("100");
  await click(payer.p, "Continue");
  const [published] = await Promise.all([
    payer.p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/tasks") && r.request().method() === "POST",
    ),
    click(payer.p, "Publish listing"),
  ]);
  assert.equal(published.status(), 201);
  const task = await published.json();
  await record("Visible new bounty publication", { taskId: task.id });
  await recipient.p.goto(
    origin + "/?view=bounties&resource=task&id=" + task.id,
  );
  await recipient.p
    .getByLabel("Your proposal", { exact: true })
    .fill("I will deliver the report");
  const [applied] = await Promise.all([
    recipient.p.waitForResponse(
      (r) =>
        r.url().endsWith(`/tasks/${task.id}/applications`) &&
        r.request().method() === "POST",
    ),
    click(recipient.p, "Send application"),
  ]);
  assert.equal(applied.status(), 201);
  const application = (await applied.json()).receipt.id;
  await record("Visible personal application", {
    applicationId: application,
    actor: recipient.id,
  });
  await api(recipient.p, `applications/${application}/consent`, {
    expectedTermsVersion: 1,
    expectedRevision: 1,
  });
  const prep = await api(
    recipient.p,
    `applications/${application}/payment-preparation`,
    {},
  );
  const alloc = await api(
    recipient.p,
    `applications/${application}/allocations`,
    {
      expectedTermsVersion: 1,
      expectedRevision: 1,
      expectedAllocationRevision: 0,
      ratios: [{ userId: recipient.id, ratioUnits: 10000 }],
      ratioDenominator: 10000,
      policyVersionId: prep.receipt.policyVersionId,
    },
  );
  for (const actor of [recipient, payer])
    await api(
      actor.p,
      `applications/${application}/allocations/1/confirmations`,
      {
        expectedRevision: 1,
        expectedTermsVersion: 1,
        allocationDigest: alloc.current.current.digest,
      },
    );
  await api(payer.p, `applications/${application}/invitation`, {
    expectedTermsVersion: 1,
    expectedRevision: 1,
  });
  const accepted = await api(
    recipient.p,
    `applications/${application}/acceptance`,
    { expectedTermsVersion: 1, expectedRevision: 1 },
  );
  const gid = accepted.agreement.id;
  currentAgreement = gid;
  const url =
    origin + "/?view=workspace&tab=agreements&resource=agreement&id=" + gid;
  await payer.p.goto(url);
  await click(payer.p, "Prepare current financial terms");
  await payer.p
    .getByRole("button", {
      name: "Review exact upfront fee reserve",
      exact: true,
    })
    .waitFor();
  await click(payer.p, "Review exact upfront fee reserve");
  await confirm(payer.p, "Confirm my exact fee reserve");
  await recipient.p.goto(url);
  await confirm(recipient.p, "Confirm my exact fee reserve");
  await payer.p.reload();
  await click(payer.p, "Get current payment quote");
  await payer.p
    .getByRole("button", { name: "Start payment of $100.55", exact: true })
    .waitFor();
  await payer.p.screenshot({
    path: fileURLToPath(
      new URL(`browser-attempt${attempt}-payment-before-1440.png`, evidence),
    ),
    fullPage: true,
  });
  // Lose the successful POST response once. Preserve original body/key across reload and recovery.
  let lost = false;
  const observed = [];
  await payer.c.route(
    "**/api/v1/funding-obligations/*/payment-attempts",
    async (route) => {
      const req = route.request();
      observed.push({
        url: req.url(),
        key: req.headers()["idempotency-key"],
        body: req.postDataJSON(),
      });
      if (!lost) {
        lost = true;
        const response = await route.fetch();
        await record("Exact attempt response deliberately lost", {
          status: response.status(),
          body: await response.json(),
        });
        assert.equal(response.status(), 202);
        await route.abort("failed");
      } else await route.continue();
    },
  );
  await payer.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  await confirm(payer.p, "Start payment of $100.55");
  await waitFor(() => observed.length === 1);
  await record("Exact attempt dispatched before reload", {
    observed,
    stored: await payer.p.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([k]) =>
          k.startsWith("campus:money:"),
        ),
      ),
    ),
  });
  await payer.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor();
  const second = await payer.c.newPage();
  await second.goto(url);
  await second
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor();
  await record("Second tab discovers the same saved intent", {
    stored: await second.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([k]) =>
          k.startsWith("campus:money:"),
        ),
      ),
    ),
  });
  await payer.p.reload();
  await record("After response loss reload", {
    url: payer.p.url(),
    actor: (await api(payer.p, "me")).id,
    stored: await payer.p.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([k]) =>
          k.startsWith("campus:money:"),
        ),
      ),
    ),
  });
  await click(payer.p, "Recover the same request");
  await payer.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  await second
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  await second.close();
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0], observed[1]);
  await record("Recovered own attempt readback", {
    funding: await api(payer.p, `agreements/${gid}/funding`),
  });
  await record(
    "Response loss and reload preserve exact original payment path/body/key",
    { requests: observed, agreementId: gid },
  );
  await waitFor(async () => {
    await click(payer.p, "Check current payment status");
    return (
      (await api(payer.p, `agreements/${gid}/funding`)).activeAttempt
        ?.status === "requires_action"
    );
  });
  await payer.p.reload();
  await click(payer.p, "Continue this payment in hosted Checkout");
  await payer.p
    .getByRole("heading", { name: "Synthetic local payment test" })
    .waitFor();
  await click(payer.p, "Simulate payment success");
  await waitFor(async () => {
    const status = await api(payer.p, `agreements/${gid}/funding`);
    return status.coverage === "covered" ? status : null;
  });
  await payer.p.goto(url);
  await recipient.p.goto(url);
  await recipient.p
    .getByLabel("Your deliverable", { exact: true })
    .fill("Synthetic completed report addressing the question.");
  await click(recipient.p, "Submit for review");
  await waitFor(async () => {
    const g = await api(recipient.p, `agreements/${gid}`);
    return g.milestones[0].state === "submitted";
  });
  await payer.p.reload();
  await payer.p.getByLabel(/I have reviewed version 1 against/).check();
  const [acceptance] = await Promise.all([
    payer.p.waitForResponse(
      (r) =>
        r.url().includes("/milestones/") &&
        r.url().endsWith("/acceptance") &&
        r.request().method() === "POST",
    ),
    click(payer.p, "Accept version 1"),
  ]);
  await record("Visible exact work acceptance response", {
    status: acceptance.status(),
    request: acceptance.request().postDataJSON(),
    body: await acceptance.json(),
  });
  assert(acceptance.ok());
  const settled = await waitFor(async () => {
    const f = await api(payer.p, `agreements/${gid}/funding`);
    return f.transferredCents === "9950" ? f : null;
  });
  await record(
    "Visible work submission, publisher acceptance and exact recipient transfer",
    { funding: settled },
  );
  await payer.p.reload();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await payer.p.setViewportSize({ width, height: 1000 });
    await payer.p
      .getByRole("heading", {
        name: "Payment and recipient transfers",
        exact: true,
      })
      .waitFor();
    assert(
      await payer.p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      "horizontal overflow " + width,
    );
    const counts = {
      paymentHeadings: await payer.p
        .getByRole("heading", {
          name: "Payment and recipient transfers",
          exact: true,
        })
        .count(),
      headers: await payer.p.locator(".cb-header").count(),
    };
    assert.deepEqual(counts, { paymentHeadings: 1, headers: 1 });
    await record("Responsive DOM integrity", { width, ...counts });
    await payer.p.screenshot({
      path: fileURLToPath(
        new URL(`browser-attempt${attempt}-viewport-${width}.png`, evidence),
      ),
      fullPage: false,
    });
    await payer.p.screenshot({
      path: fileURLToPath(
        new URL(`browser-attempt${attempt}-funded-${width}.png`, evidence),
      ),
      fullPage: true,
    });
  }
  await record(
    "Visible bounty/application/work, ordinary signed allocation services, visible payment/recovery and verified synthetic receipt",
    {
      agreementId: gid,
      funding: await api(payer.p, `agreements/${gid}/funding`),
      setupMode:
        "Visible bounty/application, fee consent, funding and work; allocation/invitation via ordinary authenticated HTTP routes",
    },
  );
  await payer.p.addScriptTag({
    path: fileURLToPath(
      new URL("../node_modules/axe-core/axe.min.js", import.meta.url),
    ),
  });
  const accessibility = await payer.p.evaluate(async () => {
    const a = await window.axe.run(document.querySelector("main"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return a.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    }));
  });
  await record("Accessibility scan", { violations: accessibility });
  assert.equal(accessibility.length, 0);
  await fs.writeFile(
    new URL("browser-actors.json", folder),
    JSON.stringify({
      payer: payer.id,
      recipient: recipient.id,
      agreementId: gid,
      taskId: task.id,
      applicationId: application,
    }),
  );
  console.log(
    "Browser scoped signup/onboarding/funding/recovery/responsive checks passed",
  );
} catch (e) {
  for (const [i, c] of browser.contexts().entries())
    for (const [j, p] of c.pages().entries()) {
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
    }
  throw e;
} finally {
  await browser.close();
}
