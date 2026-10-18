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
async function ownConsent(p, label) {
  const b = p.getByRole("button", { name: label, exact: true });
  await b.locator("..").getByRole("checkbox").check();
  const [r] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/confirmations"),
    ),
    b.click(),
  ]);
  const d = await r.json();
  await record("Personal visible amendment consent", {
    actor: (await api(p, "me")).id,
    status: r.status(),
    body: d,
  });
  assert(r.ok());
  if (label === "Confirm this revision")
    await p.getByText(/Verified confirm receipt/).waitFor();
  await p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
}
try {
  const suffix = String(Date.now()).slice(-7),
    payer = await signIn("blocked-payer-" + suffix),
    recipient = await signIn("blocked-recipient-" + suffix);
  const task = await api(payer.p, "tasks", {
    title: "Amendment visible journey",
    category: "Research",
    description: "Synthetic amendment work",
    rewardCents: 10000,
    dueDate: "2027-01-01",
    releasePolicy: "per_milestone",
    milestones: [
      {
        title: "Original report",
        amountCents: 10000,
        deliverable: "Original report",
      },
    ],
  });
  const application = (
    await api(recipient.p, `tasks/${task.id}/applications`, {
      proposal: "Exact work",
      teamId: null,
      expectedTermsVersion: 1,
      expectedRevision: 1,
    })
  ).receipt.id;
  await api(recipient.p, `applications/${application}/consent`, {
    expectedTermsVersion: 1,
    expectedRevision: 1,
  });
  const prep = await api(
    recipient.p,
    `applications/${application}/payment-preparation`,
    {},
  );
  const allocation = await api(
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
  for (const a of [payer, recipient])
    await api(a.p, `applications/${application}/allocations/1/confirmations`, {
      expectedRevision: 1,
      expectedTermsVersion: 1,
      allocationDigest: allocation.current.current.digest,
    });
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
  await api(payer.p, `agreements/${gid}/payment-preparation`, {});
  let v = await api(payer.p, `agreements/${gid}/participant-payment`);
  const plan = await api(payer.p, `agreements/${gid}/fee-plans`, {
    policyVersionId: v.feePlan.context.policyId,
    policyDigest: v.feePlan.context.policyDigest,
    sourceDigest: v.feePlan.context.sourceDigest,
  });
  for (const a of [payer, recipient])
    await api(a.p, `payment-fee-plans/${plan.receipt.planId}/confirmations`, {
      digest: plan.receipt.digest,
    });
  v = await api(payer.p, `agreements/${gid}/participant-payment`);
  const q = (
    await api(payer.p, `agreements/${gid}/payment-quotes`, v.quoteRequest)
  ).receipt;
  const initial = (
    await api(
      payer.p,
      `funding-obligations/${q.obligationId}/payment-attempts`,
      {
        quoteId: q.quoteId,
        quoteDigest: q.quoteDigest,
        expectedObligationRevision: q.obligationRevision,
        acceptedAmountCents: q.quote.chargeTotalCents,
        currency: "USD",
      },
    )
  ).receipt;
  const initialAttempt = await waitFor(async () => {
    const d = await api(payer.p, `payment-attempts/${initial.attemptId}`);
    return d.hostedUrl ? d : null;
  });
  await payer.c.request.post(
    "http://127.0.0.1:3034/complete/" +
      new URL(initialAttempt.hostedUrl).pathname.split("/").at(-1),
  );
  await waitFor(async () => {
    const d = await api(payer.p, `agreements/${gid}/funding`);
    return (
      d.coverage === "covered" && d.feePlan?.restitutionStatus === "succeeded"
    );
  });
  await record(
    "Funded base created through ordinary authenticated HTTP services",
    {
      agreementId: gid,
      funding: await api(payer.p, `agreements/${gid}/funding`),
      setupMode: "Authenticated HTTP setup, visible amendment below",
    },
  );
  const url =
    origin + "/?view=workspace&tab=agreements&resource=agreement&id=" + gid;
  const original = await api(payer.p, `agreements/${gid}`);
  await recipient.p.goto(url);
  const originalCard = recipient.p.locator(
    "#milestone-" + original.milestones[0].id,
  );
  await originalCard
    .getByLabel("Your deliverable", { exact: true })
    .fill("Original work submitted before amendment");
  await originalCard
    .getByRole("button", { name: "Submit for review", exact: true })
    .click();
  await waitFor(
    async () =>
      (await api(payer.p, `agreements/${gid}`)).milestones[0].state ===
      "submitted",
  );
  await record(
    "Original work submitted under original terms before amendment",
    { termsId: original.effectiveTerms.id },
  );
  await payer.p.goto(url);
  await click(payer.p, "Start a new proposal");
  await payer.p
    .getByLabel("Proposed total reward (USD)", { exact: true })
    .fill("110");
  await click(payer.p, "Add future stage");
  await payer.p.getByLabel("Stage 2 title", { exact: true }).fill("Follow-up");
  await payer.p.getByLabel("Stage 2 reward (USD)", { exact: true }).fill("10");
  await payer.p
    .getByLabel("Stage 2 deliverable", { exact: true })
    .fill("Follow-up report");
  await payer.p
    .getByLabel("Reason for this change", { exact: true })
    .fill("Add a separately funded follow-up");
  await click(payer.p, "Review comparison");
  const [published] = await Promise.all([
    payer.p.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/amendments"),
    ),
    click(payer.p, "Publish proposal"),
  ]);
  const created = await published.json();
  assert(published.ok());
  const aid = created.receipt.amendmentId;
  await record("Visible monetary amendment published", {
    status: published.status(),
    body: created,
  });
  await payer.p.getByText(/Verified propose receipt/).waitFor();
  for (const a of [payer, recipient]) {
    await a.p.goto(url);
    await ownConsent(a.p, "Confirm this revision");
  }
  await payer.p.reload();
  await click(payer.p, "Prepare and review a fresh financial plan");
  await payer.p
    .getByRole("button", {
      name: "Confirm my amendment financial terms",
      exact: true,
    })
    .waitFor();
  await ownConsent(payer.p, "Confirm my amendment financial terms");
  await recipient.p.reload();
  await ownConsent(recipient.p, "Confirm my amendment financial terms");
  await recipient.p.goto(origin + "/?view=account");
  await click(recipient.p, "Prepare my recipient account");
  await recipient.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  await click(recipient.p, "Create my recipient account");
  await waitFor(
    async () =>
      (await api(recipient.p, "me/payment-account")).transferCapability ===
      "active",
  );
  await payer.p.goto(url);
  await payer.p
    .getByText(
      "The original agreement’s money or recipient capability changed. Review a fresh financial plan before paying.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await payer.p
      .getByRole("button", {
        name: "Review current amendment payment quote",
        exact: true,
      })
      .count(),
    0,
  );
  const blocked = await api(
    payer.p,
    `agreements/${gid}/amendments/${aid}/financial-plans`,
  );
  assert(
    blocked.plans
      .at(-1)
      .blockedReasons.includes("original_money_state_changed"),
  );
  assert.equal(blocked.plans.at(-1).obligationId, null);
  await record("Visible M1 blocker matches initial quote authority", {
    financial: blocked,
  });
  await payer.p
    .getByRole("button", {
      name: "Prepare and review a fresh financial plan",
      exact: true,
    })
    .focus();
  await payer.p.keyboard.press("Enter");
  const fresh = await waitFor(async () => {
    const d = await api(
      payer.p,
      `agreements/${gid}/amendments/${aid}/financial-plans`,
    );
    return d.plans.length === 2 ? d : null;
  });
  assert.equal(fresh.plans.at(-1).confirmedParticipantIds.length, 0);
  assert.equal(fresh.plans.at(-1).obligationId, null);
  await record(
    "Visible fresh-plan recovery needs new personal signatures and creates no charge",
    { financial: fresh },
  );
  await payer.p
    .getByRole("heading", {
      name: "Amendment financial agreement",
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await payer.p.screenshot({
    path: fileURLToPath(
      new URL(`browser-attempt${attempt}-blocked-recovery.png`, evidence),
    ),
  });
  console.log("Visible M1 blocker and fresh-plan recovery passed");
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
