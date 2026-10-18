import { syntheticPolicyPayload } from "./backend/transaction-terms-fixture.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { localConfig, connectionString } from "../scripts/backend-local.mjs";
import { createStore } from "../backend/db/store.mjs";
import { createMarket } from "../backend/modules/market.mjs";
const folder = new URL(
    "../.data/backend/transaction-terms-fix1/",
    import.meta.url,
  ),
  evidence = new URL(
    "../.superpowers/sdd/transaction-integration-plan/task-2a-fix1-evidence/",
    import.meta.url,
  );
const release = JSON.parse(
  await fs.readFile(new URL("release.json", folder), "utf8"),
);
const targets = JSON.parse(
  await fs.readFile(
    new URL(
      "../.superpowers/sdd/transaction-integration-plan/task-2a-fix1-targets.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
assert.equal(release.database, targets.authorizedNewDatabaseNames[1]);
assert.equal(release.origin, "http://127.0.0.1:3022");
const k = randomUUID;
const checks = JSON.parse(
  await fs
    .readFile(new URL("browser.json", evidence), "utf8")
    .catch(() => "[]"),
);
const record = async (check, extra = {}) => {
  checks.push({ at: new Date().toISOString(), check, ...extra });
  await fs.writeFile(
    new URL("browser.json", evidence),
    JSON.stringify(checks, null, 2),
  );
};
const btn = (p, name) => p.getByRole("button", { name, exact: true });
async function service(fn) {
  const conf = localConfig(),
    store = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((r) => [
          r,
          connectionString(conf, r, release.database),
        ]),
      ),
    );
  try {
    return await fn(createMarket(store));
  } finally {
    await store.close();
  }
}
async function owner(fn) {
  const c = new pg.Client({
    connectionString: connectionString(
      localConfig(),
      "migrator",
      release.database,
    ),
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
export async function login(p, role) {
  await p.goto(release.origin);
  await btn(p, "Sign out")
    .or(p.getByLabel("University email", { exact: true }))
    .first()
    .waitFor();
  if (await btn(p, "Sign out").isVisible()) await btn(p, "Sign out").click();
  await p
    .getByLabel("University email", { exact: true })
    .fill(release.recipients[role]);
  const start = Date.now();
  await btn(p, "Email me a sign-in code").click();
  await p.getByLabel("Sign-in code", { exact: true }).waitFor();
  let code;
  for (let i = 0; i < 100; i++) {
    try {
      const path = new URL(role + ".eml", folder);
      if ((await fs.stat(path)).mtimeMs >= start)
        code = (await fs.readFile(path, "utf8")).match(
          /verification code is (\d{6})/,
        )?.[1];
    } catch {}
    if (code) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, "Local synthetic code delivered");
  await p.getByLabel("Sign-in code", { exact: true }).fill(code);
  await p.getByLabel("Your display name").fill("T2A " + role);
  await btn(p, "Verify and continue").click();
  await btn(p, "Sign out").waitFor();
  await record("ordinary email code login", { role, sessionInjected: false });
}
export async function publish(p) {
  await login(p, "publisher");
  const tasks = [];
  for (const mode of ["per_milestone", "final_completion"]) {
    await p.goto(release.origin + "/?view=publish&kind=task");
    await p.getByLabel("Title", { exact: true }).fill("T2A browser " + mode);
    await p
      .getByLabel("Description", { exact: true })
      .fill("Visible synthetic transaction engineering journey.");
    await p
      .getByLabel("Total bounty reward (USD)", { exact: true })
      .fill("200");
    await p
      .getByLabel("Target delivery date", { exact: true })
      .fill("2027-01-01");
    await btn(p, "Continue").click();
    await p
      .getByRole("radio", {
        name:
          mode === "per_milestone"
            ? "After each accepted milestone"
            : "After final completion",
        exact: true,
      })
      .check();
    await p
      .getByLabel("Milestone title", { exact: true })
      .fill("Research report");
    await p
      .getByLabel("Expected deliverable", { exact: true })
      .fill("Annotated report");
    await p
      .getByLabel("Acceptance criteria", { exact: true })
      .fill("Include primary citations");
    await p.getByLabel("Milestone reward (USD)", { exact: true }).fill("200");
    await btn(p, "Continue").click();
    await btn(p, "Publish listing").click();
    await p.waitForURL(
      (u) =>
        u.searchParams.get("view") === "bounties" && !!u.searchParams.get("id"),
    );
    const id = new URL(p.url()).searchParams.get("id");
    await p
      .getByText("The full reward must be funded upfront in either mode.", {
        exact: false,
      })
      .waitFor();
    tasks.push(id);
    await record("published visible explicit release choice", {
      mode,
      taskId: id,
    });
  }
  await fs.writeFile(
    new URL("browser-tasks.json", folder),
    JSON.stringify(tasks),
  );
  return { tasks };
}
export async function prepare() {
  const tasks = JSON.parse(
    await fs.readFile(new URL("browser-tasks.json", folder), "utf8"),
  );
  return await service(async (m) => {
    const u = release.users;
    const team = await m.createTeam(
      u.captain,
      {
        name: "T2A visible recipients",
        context: {
          purpose: "Research",
          activities: "Write annotated report",
          timeCommitment: "Two hours",
          projectContext: "Synthetic isolated journey",
        },
      },
      k(),
    );
    await m.inviteMember(
      u.captain,
      team.id,
      { userId: u.member, expectedRevision: team.revision },
      k(),
    );
    await m.acceptMembership(
      u.member,
      team.id,
      { expectedRevision: (await m.team(u.member, team.id)).revision },
      k(),
    );
    const t = await m.task(u.captain, tasks[0]);
    const a = await m.applyVersioned(
      u.captain,
      t.id,
      {
        proposal: "Frozen two-person browser proposal",
        teamId: team.id,
        expectedTermsVersion: t.terms_version,
        expectedRevision: t.revision,
      },
      k(),
    );
    await fs.writeFile(
      new URL("browser-app.json", folder),
      JSON.stringify({ id: a.receipt.id, task: t }),
    );
    await record("service-created frozen team application", {
      applicationId: a.receipt.id,
    });
    return { applicationId: a.receipt.id };
  });
}
async function open(p) {
  const a = JSON.parse(
    await fs.readFile(new URL("browser-app.json", folder), "utf8"),
  );
  await p.goto(
    `${release.origin}/?view=workspace&tab=applications&resource=application&id=${a.id}`,
  );
  await p
    .getByRole("heading", {
      name: "Recipient allocation and financial consent",
    })
    .waitFor();
  return a;
}
async function acknowledge(p) {
  await btn(p, "Review current terms").click();
  await p
    .getByRole("checkbox", { name: /I have reviewed and agree to version/ })
    .check();
  const confirm = btn(p, "Confirm version 1");
  if (await confirm.isVisible()) {
    const done = p.waitForResponse(
      (r) => r.url().endsWith("/consent") && r.request().method() === "POST",
    );
    await confirm.click();
    await done;
  }
}
async function confirm(p, financial = false) {
  await p
    .getByRole("checkbox", {
      name: financial
        ? /I confirm saved revision .*exact financial terms/
        : /I confirm saved revision .*percentages only/,
    })
    .check();
  await btn(
    p,
    financial ? "Confirm financial terms" : "Confirm ratios only",
  ).click();
  await p.getByText("Saved exact revision", { exact: true }).waitFor();
}
export async function propose(p) {
  await login(p, "captain");
  await open(p);
  await acknowledge(p);
  await p.getByLabel("T2A captain percentage", { exact: true }).fill("60");
  await p.getByLabel("T2A member percentage", { exact: true }).fill("40");
  await btn(p, "Propose allocation revision").click();
  await p.getByText("Saved exact revision", { exact: true }).waitFor();
  await confirm(p);
  await p.reload();
  await p
    .getByText("estimated processing fee: Pending trusted estimate", {
      exact: false,
    })
    .waitFor();
  await record(
    "captain proposed 60/40 and confirmed own ratios; reload preserves pending estimate",
  );
  await p.screenshot({
    path: fileURLToPath(new URL("ratios-desktop.png", evidence)),
    fullPage: true,
  });
  return "proposed and confirmed";
}
export async function member(p) {
  await login(p, "member");
  await open(p);
  await acknowledge(p);
  assert.equal(await btn(p, "Propose allocation revision").count(), 0);
  await confirm(p);
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({
    path: fileURLToPath(new URL("member-mobile.png", evidence)),
    fullPage: true,
  });
  assert.equal(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await record(
    "second member individually confirmed; no captain editor; mobile 390px no overflow",
  );
  return "member confirmed";
}
export async function publisher(p) {
  await p.setViewportSize({ width: 1280, height: 900 });
  await login(p, "publisher");
  const a = await open(p);
  await confirm(p);
  await btn(p, "Send invitation for version 1").click();
  await service(async (m) => {
    const d = await m.applicationAllocation(release.users.publisher, a.id);
    assert.equal(
      d.confirmations.filter((c) => c.allocation_id === d.current.id).length,
      3,
    );
    assert.ok(d.blockedReasons.includes("fee_policy_pending"));
  });
  await record(
    "publisher saw correct proportions and all three ratio-only confirmations; fees still block acceptance",
  );
  return "publisher checked";
}
export async function policy() {
  const a = JSON.parse(
    await fs.readFile(new URL("browser-app.json", folder), "utf8"),
  );
  const id = k();
  await owner((c) =>
    c.query(
      "INSERT INTO campus.payment_policy_versions(id,application_id,listing_version,status,provenance,payload) VALUES($1,$2,1,'approved','Task2A browser synthetic only',$3)",
      [id, a.id, JSON.stringify(syntheticPolicyPayload())],
    ),
  );
  await record(
    "application-scoped synthetic policy installed; not provider fee evidence",
    { policyId: id },
  );
  return "synthetic policy installed";
}
export async function revise(p) {
  await login(p, "captain");
  const a = await open(p);
  await p.getByLabel("T2A captain percentage", { exact: true }).fill("70");
  await p.getByLabel("T2A member percentage", { exact: true }).fill("30");
  await btn(p, "Propose allocation revision").click();
  await p.getByText("Saved exact revision", { exact: true }).waitFor();
  await service(async (m) => {
    const d = await m.applicationAllocation(release.users.captain, a.id);
    assert.equal(d.current.revision, 2);
    assert.equal(
      d.confirmations.filter((c) => c.allocation_id === d.current.id).length,
      0,
    );
  });
  await confirm(p, true);
  await record(
    "70/30 exact-policy revision resets every confirmation; captain signs only himself",
  );
  return "revised";
}
export async function finish(p) {
  await login(p, "member");
  await open(p);
  await confirm(p, true);
  await login(p, "publisher");
  await open(p);
  await confirm(p, true);
  await login(p, "captain");
  const a = await open(p);
  await btn(p, "Review current terms").click();
  await p.getByRole("checkbox", { name: /I have reviewed and agree/ }).check();
  await btn(p, "Accept invitation for version 1").click();
  await p.waitForURL((u) => u.searchParams.get("resource") === "agreement");
  const id = new URL(p.url()).searchParams.get("id");
  await p.getByText("Waiting for funding", { exact: true }).waitFor();
  await p.getByText("Signed recipient amounts", { exact: true }).click();
  await p.screenshot({
    path: fileURLToPath(new URL("accepted-binding.png", evidence)),
    fullPage: true,
  });
  await service(async (m) => {
    const g = await m.agreement(release.users.publisher, id);
    assert.equal(g.transaction.terms[0].allocation_revision, 2);
    assert.equal(
      g.transaction.allocations.reduce((s, c) => s + c.net_cents, 0),
      19700,
    );
    assert.equal(g.state, "awaiting_funding");
  });
  await record(
    "two members plus publisher signed exact financial revision; visible acceptance binds it atomically",
    {
      agreementId: id,
      applicationId: a.id,
      state: "awaiting_funding",
      fundsMoved: false,
    },
  );
  return "exact accepted binding";
}
export async function repairListingAck(p) {
  await login(p, "member");
  await open(p);
  await btn(p, "Review current terms").click();
  await p.getByRole("checkbox", { name: /I have reviewed and agree/ }).check();
  const response = p.waitForResponse(
    (r) => r.url().endsWith("/consent") && r.request().method() === "POST",
  );
  await btn(p, "Confirm version 1").click();
  const r = await response;
  const body = await r.json();
  await record("listing acknowledgement response diagnostic", {
    status: r.status(),
    body,
  });
  assert.equal(body.current.reviewRequired, false);
  return "listing ack recovered";
}
export async function finalAcceptance(p) {
  await login(p, "publisher");
  await open(p);
  const invited = p.waitForResponse(
    (r) => r.url().endsWith("/invitation") && r.request().method() === "POST",
  );
  await btn(p, "Send invitation for version 1").click();
  const invitationResponse = await invited;
  const invitationBody = await invitationResponse.json();
  await record("normal publisher invitation response after final consent", {
    status: invitationResponse.status(),
    body: invitationBody,
  });
  assert.equal(invitationResponse.status(), 200);
  assert.ok(invitationBody.current.currentInvitation);
  await login(p, "captain");
  const a = await open(p);
  await btn(p, "Review current terms").click();
  await p.getByRole("checkbox", { name: /I have reviewed and agree/ }).check();
  await btn(p, "Accept invitation for version 1").click();
  await p.waitForURL((u) => u.searchParams.get("resource") === "agreement");
  const id = new URL(p.url()).searchParams.get("id");
  await p.getByText("Waiting for funding", { exact: true }).waitFor();
  await p.getByText("Signed recipient amounts", { exact: true }).click();
  await p.screenshot({
    path: fileURLToPath(new URL("accepted-binding.png", evidence)),
    fullPage: true,
  });
  await service(async (m) => {
    const g = await m.agreement(release.users.publisher, id);
    assert.equal(g.transaction.terms[0].allocation_revision, 2);
    assert.equal(
      g.transaction.allocations.reduce((s, c) => s + c.net_cents, 0),
      19700,
    );
    assert.equal(g.state, "awaiting_funding");
  });
  await record("visible exact-policy acceptance bound; awaiting funding", {
    agreementId: id,
    applicationId: a.id,
    fundsMoved: false,
  });
  return id;
}
export async function recovery(p) {
  const tasks = JSON.parse(
      await fs.readFile(new URL("browser-tasks.json", folder), "utf8"),
    ),
    u = release.users;
  const fixture = await service(async (m) => {
    const team = (await m.teams(u.captain)).find(
      (t) => t.name === "T2A visible recipients",
    );
    const t = await m.task(u.captain, tasks[1]);
    const a = await m.applyVersioned(
      u.captain,
      t.id,
      {
        proposal: "Unknown response and stale revision journey",
        teamId: team.id,
        expectedTermsVersion: t.terms_version,
        expectedRevision: t.revision,
      },
      k(),
    );
    return { id: a.receipt.id, task: t };
  });
  await p.goto(
    `${release.origin}/?view=workspace&tab=applications&resource=application&id=${fixture.id}`,
  );
  await p.getByLabel("T2A captain percentage", { exact: true }).fill("60");
  await p.getByLabel("T2A member percentage", { exact: true }).fill("40");
  const requests = [];
  let lost = true;
  const path = `**/api/v1/applications/${fixture.id}/allocations`;
  await p.route(path, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (lost) {
      lost = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort("failed");
    }
    return route.continue();
  });
  await btn(p, "Propose allocation revision").click();
  await btn(p, "Recover previous allocation request").waitFor();
  // Simulate a corrupt optional ratio draft only; never touch auth or the frozen command.
  await p.evaluate(
    ({ actor, id }) =>
      localStorage.setItem(
        `campus:allocation-draft:${actor}:${id}`,
        JSON.stringify({ [actor]: "invalid" }),
      ),
    { actor: u.captain, id: fixture.id },
  );
  await p.reload();
  await btn(p, "Recover previous allocation request").click();
  await p.getByText("Recovered original receipt", { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  await p.unroute(path);
  await record(
    "lost successful response recovered after reload with identical body/key; invalid current draft cannot block recovery",
    { applicationId: fixture.id },
  );
  const previous = await service((m) =>
    m.applicationAllocation(u.captain, fixture.id),
  );
  await service((m) =>
    m.editTask(
      u.publisher,
      fixture.task.id,
      {
        expectedRevision: fixture.task.revision,
        terms: {
          title: fixture.task.title,
          category: fixture.task.category,
          description: fixture.task.description,
          rewardCents: fixture.task.reward_cents,
          dueDate: fixture.task.due_date,
          releasePolicy: "per_milestone",
          milestones: fixture.task.milestones.map((v) => ({
            title: v.title,
            amountCents: v.amount_cents,
            deliverable: v.deliverable,
            acceptanceCriteria: v.acceptance_criteria,
          })),
        },
      },
      k(),
    ),
  );
  await p
    .getByRole("checkbox", {
      name: /I confirm saved revision .*percentages only/,
    })
    .check();
  await btn(p, "Confirm ratios only").click();
  await p
    .getByText("Review current transaction terms", { exact: false })
    .waitFor();
  assert.equal(await btn(p, "Confirm ratios only").isDisabled(), true);
  await btn(p, "Refresh allocation and review stale terms").click();
  await p
    .getByText("Listing version 2 · allocation revision 1.", { exact: false })
    .waitFor();
  await record(
    "release-policy edit invalidates financial source version; stale command blocked until explicit refresh",
    { previousDigest: previous.current.digest },
  );
  await p.screenshot({
    path: fileURLToPath(new URL("stale-refresh.png", evidence)),
    fullPage: true,
  });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({
    path: fileURLToPath(new URL("final-mobile.png", evidence)),
    fullPage: true,
  });
  assert.equal(
    await p.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await record(
    "final percentage UI and stale refresh at mobile 390px; no horizontal overflow",
  );
  await btn(p, "Sign out").click();
  await p.getByLabel("University email", { exact: true }).waitFor();
  assert.equal(
    await p
      .getByRole("heading", {
        name: "Recipient allocation and financial consent",
      })
      .count(),
    0,
  );
  await record("sign-out clears private allocation content");
  return "unknown/stale/account-state verified";
}

export async function fix1Setup() {
  const task = await service((m) =>
    m.publishTask(
      release.users.publisher,
      {
        title: "Fix1 saved financial consent",
        category: "Research",
        description: "Scoped synthetic policy disclosure verification.",
        rewardCents: 20000,
        dueDate: "2027-01-01",
        releasePolicy: "per_milestone",
        milestones: [
          {
            title: "Research report",
            amountCents: 20000,
            deliverable: "Annotated report",
            acceptanceCriteria: "Primary sources",
          },
        ],
      },
      k(),
    ),
  );
  await fs.writeFile(
    new URL("browser-tasks.json", folder),
    JSON.stringify([task.id]),
  );
  await prepare();
  return task.id;
}
export async function fix1Consent(p) {
  await login(p, "captain");
  const a = await open(p);
  await p.getByLabel("T2A captain percentage", { exact: true }).fill("60");
  await p.getByLabel("T2A member percentage", { exact: true }).fill("40");
  await btn(p, "Propose allocation revision").click();
  await p.getByText("Saved exact revision", { exact: true }).waitFor();
  await policy();
  await p.reload();
  await btn(p, "Propose allocation revision").click();
  await p.getByText("Saved exact revision", { exact: true }).waitFor();
  const saved = await service((m) =>
    m.applicationAllocation(release.users.captain, a.id),
  );
  assert.equal(saved.current.revision, 2);
  async function checkSaved(role) {
    const summary = p.getByRole("region", {
      name: "Saved allocation proportions",
    });
    assert.match(await summary.innerText(), /T2A captain: 60%/);
    assert.match(await summary.innerText(), /T2A member: 40%/);
    assert.match(await summary.innerText(), /Saved revision 2/);
    const policyView = p.getByRole("region", {
      name: "Saved financial policy",
    });
    await policyView.waitFor();
    for (const kind of ["feeAdjustment", "tax", "refund"]) {
      const v = saved.current.policy_snapshot.payload.disclosure[kind];
      await policyView.getByText(v.description, { exact: true }).waitFor();
      await policyView
        .getByRole("heading", {
          name: `${v.title} · version ${v.version}`,
          exact: true,
        })
        .waitFor();
    }
    await record(
      "fix1 saved percentages and immutable readable policy visible",
      { role, allocationRevision: 2, policyId: saved.current.policy_id },
    );
  }
  await p.getByLabel("T2A captain percentage", { exact: true }).fill("70");
  await p.getByLabel("T2A member percentage", { exact: true }).fill("30");
  await checkSaved("captain with unsaved 70/30 draft");
  assert.equal(
    await p.getByLabel("T2A captain percentage", { exact: true }).inputValue(),
    "70",
  );
  await p.screenshot({
    path: fileURLToPath(new URL("fix1-captain-unsaved.png", evidence)),
    fullPage: true,
  });
  await confirm(p, true);
  const confirmed = await service((m) =>
    m.applicationAllocation(release.users.captain, a.id),
  );
  assert.equal(confirmed.current.digest, saved.current.digest);
  assert.equal(confirmed.current.revision, 2);
  assert.equal(
    confirmed.confirmations.find(
      (c) =>
        c.user_id === release.users.captain &&
        c.allocation_id === saved.current.id,
    ).digest,
    saved.current.digest,
  );
  await record(
    "fix1 unsaved draft did not change signed saved 60/40 revision",
    { digest: saved.current.digest },
  );
  for (const role of ["member", "publisher"]) {
    await login(p, role);
    await open(p);
    await p.setViewportSize({
      width: role === "member" ? 390 : 1280,
      height: 900,
    });
    await checkSaved(role);
    assert.equal(
      await p.getByLabel("T2A captain percentage", { exact: true }).count(),
      0,
    );
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await p.screenshot({
      path: fileURLToPath(new URL(`fix1-${role}-policy.png`, evidence)),
      fullPage: true,
    });
    await confirm(p, true);
  }
  const final = await service((m) =>
    m.applicationAllocation(release.users.publisher, a.id),
  );
  assert.equal(
    final.confirmations.filter(
      (c) =>
        c.allocation_id === saved.current.id &&
        c.digest === saved.current.digest &&
        c.consent_kind === "financial_terms",
    ).length,
    3,
  );
  assert.deepEqual(
    final.current.policy_snapshot,
    saved.current.policy_snapshot,
  );
  await record(
    "fix1 all three normal actors signed saved exact revision with policy text",
    {
      applicationId: a.id,
      digest: saved.current.digest,
      financialExecution: false,
    },
  );
  await btn(p, "Sign out").click();
  await p.getByLabel("University email", { exact: true }).waitFor();
  return "captain unsaved draft, member mobile and publisher saved consent verified";
}
