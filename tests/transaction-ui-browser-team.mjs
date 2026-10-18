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
  const button = p.getByRole("button", { name: label, exact: true });
  await button.locator("..").getByRole("checkbox").check();
  const [r] = await Promise.all([
    p.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/confirmations"),
    ),
    button.click(),
  ]);
  const body = await r.json();
  assert(r.ok());
  await record(label, {
    actor: (await api(p, "me")).id,
    status: r.status(),
    body,
  });
  if (label === "Confirm this revision")
    await p.getByText(/Verified confirm receipt/).waitFor();
  else
    await p
      .getByRole("button", { name: "Recover the same request", exact: true })
      .waitFor({ state: "hidden" });
}
try {
  const suffix = String(Date.now()).slice(-7),
    payer = await signIn("team-payer-" + suffix),
    recipient = await signIn("team-captain-" + suffix);
  await api(recipient.p, "me/payment-account/preparation", {});
  const cfg = await api(recipient.p, "me/payment-account");
  await api(recipient.p, "me/payment-account/onboarding", {
    expectedAccountRevision: cfg.revision,
  });
  await waitFor(
    async () =>
      (await api(recipient.p, "me/payment-account")).transferCapability ===
      "active",
  );
  const member = await signIn("team-member-" + suffix);
  await api(member.p, "me/payment-account/preparation", {});
  await api(member.p, "me/payment-account/onboarding", {
    expectedAccountRevision: 0,
  });
  await waitFor(
    async () =>
      (await api(member.p, "me/payment-account")).transferCapability ===
      "active",
  );
  const team = await api(recipient.p, "teams", {
    name: "Synthetic exact ratio team",
    context: {
      purpose: "Research",
      activities: "Read sources",
      timeCommitment: "One hour",
      projectContext: "",
    },
  });
  await api(recipient.p, `teams/${team.id}/invitations`, {
    userId: member.id,
    expectedRevision: team.revision,
  });
  await api(member.p, `teams/${team.id}/membership`, {
    expectedRevision: (await api(member.p, `teams/${team.id}`)).revision,
  });
  const task = await api(payer.p, "tasks", {
    title: "Amendment visible journey",
    category: "Research",
    description: "Synthetic amendment work",
    rewardCents: 10000,
    dueDate: "2027-01-01",
    releasePolicy: "final_completion",
    milestones: [
      { title: "First report", amountCents: 5000, deliverable: "First report" },
      { title: "Final report", amountCents: 5000, deliverable: "Final report" },
    ],
  });
  const application = (
    await api(recipient.p, `tasks/${task.id}/applications`, {
      proposal: "Exact work",
      teamId: team.id,
      expectedTermsVersion: 1,
      expectedRevision: 1,
    })
  ).receipt.id;
  for (const actor of [recipient, member])
    await api(actor.p, `applications/${application}/consent`, {
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
      ratios: [
        { userId: recipient.id, ratioUnits: 6000 },
        { userId: member.id, ratioUnits: 4000 },
      ],
      ratioDenominator: 10000,
      policyVersionId: prep.receipt.policyVersionId,
    },
  );
  for (const a of [payer, recipient, member])
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

  const url =
    origin + "/?view=workspace&tab=agreements&resource=agreement&id=" + gid;
  await payer.p.goto(url);
  await click(payer.p, "Prepare current financial terms");
  const [reserve] = await Promise.all([
    payer.p.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/fee-plans"),
    ),
    click(payer.p, "Review exact upfront fee reserve"),
  ]);
  assert(reserve.ok());
  await record("Exact team fee plan created", { body: await reserve.json() });
  await payer.p
    .getByRole("button", { name: "Confirm my exact fee reserve", exact: true })
    .waitFor();
  await payer.p
    .getByRole("button", { name: "Recover the same request", exact: true })
    .waitFor({ state: "hidden" });
  for (const a of [payer, recipient, member]) {
    await a.p.goto(url);
    await ownConsent(a.p, "Confirm my exact fee reserve");
  }
  await payer.p.goto(url);
  await click(payer.p, "Get current payment quote");
  const b = payer.p.getByRole("button", {
    name: "Start payment of $100.55",
    exact: true,
  });
  await b.locator("..").getByRole("checkbox").check();
  await b.click();
  const fundedAttempt = await waitFor(async () => {
    const d = await api(payer.p, `agreements/${gid}/funding`);
    return d.activeAttempt?.status === "requires_action"
      ? d.activeAttempt
      : null;
  });
  await payer.p.reload();
  await click(payer.p, "Continue this payment in hosted Checkout");
  await click(payer.p, "Simulate payment success");
  await waitFor(
    async () =>
      (await api(payer.p, `agreements/${gid}/funding`)).coverage === "covered",
  );
  await record(
    "Team all-person visible fee consent and explicit final-completion funding",
    { funding: await api(payer.p, `agreements/${gid}/funding`) },
  );
  await payer.p.goto(url);
  await click(payer.p, "Start a new proposal");
  await payer.p
    .getByLabel("General scope", { exact: true })
    .fill(
      "Clarified description with unchanged reward, stages and release choice",
    );
  await payer.p
    .getByLabel("Reason for this change", { exact: true })
    .fill("Nonmonetary clarification");
  await click(payer.p, "Review comparison");
  const [published] = await Promise.all([
    payer.p.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/amendments"),
    ),
    click(payer.p, "Publish proposal"),
  ]);
  assert(published.ok());
  const aid = (await published.json()).receipt.amendmentId;
  await payer.p.getByText(/Verified propose receipt/).waitFor();
  for (const a of [payer, recipient, member]) {
    await a.p.goto(url);
    await ownConsent(a.p, "Confirm this revision");
  }
  const effective = await waitFor(async () => {
    const d = await api(payer.p, `agreements/${gid}`);
    return d.effectiveTerms.revision === 2 ? d : null;
  });
  const money = await api(payer.p, `agreements/${gid}/funding`);
  assert.equal(money.activeAttempt.id, fundedAttempt.id);
  assert.equal(money.receivedCents, "10055");
  assert.equal(
    (await api(payer.p, `agreements/${gid}/amendments/${aid}/financial-plans`))
      .plans.length,
    0,
  );
  await record("Visible nonmonetary all-person amendment adds no payment", {
    termsRevision: 2,
    funding: money,
  });
  for (let i = 0; i < 2; i++) {
    const mid = effective.milestones[i].id;
    await recipient.p.goto(url);
    const card = recipient.p.locator("#milestone-" + mid);
    await card
      .getByLabel("Your deliverable", { exact: true })
      .fill("Completed team report " + i);
    await card
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await waitFor(
      async () =>
        (await api(payer.p, `agreements/${gid}`)).milestones[i].state ===
        "submitted",
    );
    await payer.p.goto(url);
    const review = payer.p.locator("#milestone-" + mid);
    await review.getByLabel(/I have reviewed version 1 against/).check();
    await review
      .getByRole("button", { name: "Accept version 1", exact: true })
      .click();
    await waitFor(
      async () =>
        (await api(payer.p, `agreements/${gid}`)).milestones[i].state ===
        "accepted",
    );
    if (i === 0) {
      const f = await api(payer.p, `agreements/${gid}/funding`);
      assert.equal(f.transferredCents, "0");
      assert(f.payees.every((p) => !p.releaseReady));
      await record(
        "Final-completion choice prevents transfer after first accepted stage",
        { funding: f },
      );
    }
  }
  const final = await waitFor(async () => {
    const d = await api(payer.p, `agreements/${gid}/funding`);
    return d.transferredCents === "9950" ? d : null;
  });
  for (const [who, amount] of [
    [recipient.id, 5970],
    [member.id, 3980],
  ])
    assert.equal(
      final.payees
        .filter((p) => p.memberId === who)
        .reduce((n, p) => n + Number(p.transferredCents), 0),
      amount,
    );
  await record("Final stage releases exact separate team member transfers", {
    funding: final,
  });
  await payer.p.goto(url);
  const history = payer.p.getByRole("button", {
    name: /Open proposal revision 1: Nonmonetary clarification/,
  });
  await history.focus();
  await history.press("Enter");
  await payer.p
    .getByRole("heading", { name: "Proposal revision 1", exact: true })
    .waitFor();
  assert.equal(
    await payer.p.evaluate(() => document.activeElement?.id),
    "amendment-" + aid + "-revision-1",
  );
  await record(
    "Completed amendment discoverable from visible changes history",
    { agreementId: gid, amendmentId: aid },
  );
  for (const width of [390, 1440]) {
    await payer.p.setViewportSize({ width, height: 1000 });
    await payer.p
      .getByRole("heading", {
        name: "Payment and recipient transfers",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await payer.p.screenshot({
      path: fileURLToPath(
        new URL(`browser-attempt${attempt}-team-${width}.png`, evidence),
      ),
    });
  }
  console.log("Team final completion and nonmonetary amendment passed");
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
