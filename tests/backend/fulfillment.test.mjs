import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
import { connectionString } from "../../scripts/backend-local.mjs";
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const code = (value) => (e) => e.code === value;
const background = {
  purpose: "Synthetic collaboration",
  activities: "Review sources",
  timeCommitment: "One hour",
  projectContext: "",
};
const body = (count) => ({
  title: "Synthetic delivery",
  category: "Research",
  description: "Local test",
  rewardCents: 100 * count,
  milestones: Array.from({ length: count }, (_, i) => ({
    title: `Phase ${i + 1}`,
    amountCents: 100,
    deliverable: "Annotated notes",
    acceptanceCriteria: "Citations present",
  })),
});
const submission = (m, content = "Original work") => ({
  content,
  expectedVersion: m.version,
  expectedRevision: m.revision,
});
const review = (result) => ({
  submissionId: result.submission.id,
  expectedVersion: result.milestone.version,
  expectedRevision: result.milestone.revision,
});
async function scenario(count = 2) {
  const owner = await f.user("Publisher"),
    captain = await f.user("Captain"),
    outsider = await f.user("Outsider");
  const task = await market.publishTask(owner, body(count), key());
  const app = await market.apply(
    captain,
    task.id,
    { proposal: "Delivery plan", teamId: null },
    key(),
  );
  await market.inviteApplicant(owner, app.id, {}, key());
  const agreement = await market.acceptInvitation(captain, app.id, {}, key());
  await f.owner.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [agreement.id],
  );
  return {
    owner,
    captain,
    outsider,
    task,
    app,
    agreement: await market.agreement(owner, agreement.id),
  };
}
test("review history remains exact and immutable through resubmission, receipt replay and final completion", async () => {
  const s = await scenario(),
    [m, n] = s.agreement.milestones;
  const request = submission(m, "  Draft one  "),
    once = key();
  const first = await market.submitMilestone(s.captain, m.id, request, once);
  assert.equal(first.submission.content, "Draft one");
  const feedback = await market.requestMilestoneRevision(
    s.owner,
    m.id,
    { ...review(first), feedback: "  Add references.  " },
    key(),
  );
  assert.equal(feedback.milestone.revision, 3);
  assert.equal(feedback.milestone.version, 1);
  const second = await market.submitMilestone(
    s.captain,
    m.id,
    submission(feedback.milestone, "Draft two with references"),
    key(),
  );
  const replay = await market.submitMilestone(s.captain, m.id, request, once);
  assert.equal(replay.receipt.submissionId, first.submission.id);
  assert.equal(replay.submission.id, second.submission.id);
  await assert.rejects(
    market.acceptMilestone(s.owner, m.id, review(first), key()),
    code("stale_revision"),
  );
  const accepted = await market.acceptMilestone(
    s.owner,
    m.id,
    review(second),
    key(),
  );
  assert.equal(accepted.agreement.state, "active");
  const last = await market.submitMilestone(
    s.captain,
    n.id,
    submission(n),
    key(),
  );
  const finalKey = key(),
    acceptedLast = await market.acceptMilestone(
      s.owner,
      n.id,
      review(last),
      finalKey,
    );
  assert.equal(acceptedLast.agreement.state, "completed");
  assert.deepEqual(
    await market.acceptMilestone(s.owner, n.id, review(last), finalKey),
    acceptedLast,
  );
  const history = await market.milestoneReviews(s.owner, m.id);
  assert.deepEqual(
    history.map((x) => [
      x.submission_id,
      x.submission_version,
      x.milestone_revision,
      x.decision,
      x.feedback,
    ]),
    [
      [first.submission.id, 1, 3, "revision_requested", "Add references."],
      [second.submission.id, 2, 5, "accepted", ""],
    ],
  );
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.milestone_reviews SET feedback='rewrite' WHERE id=$1",
      [history[0].id],
    ),
    code("23514"),
  );
  assert.deepEqual(
    (await market.agreement(s.owner, s.agreement.id)).terms,
    s.agreement.terms,
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT * FROM campus.events WHERE object_id=$1 AND kind='agreement.completed'",
        [s.agreement.id],
      )
    ).rowCount,
    1,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [s.captain],
  );
  await assert.rejects(
    market.submitMilestone(s.captain, m.id, request, once),
    code("account_locked"),
  );
});
test("simultaneous final accepts complete once while review versus replacement has one exact-version winner", async () => {
  const s = await scenario(),
    results = [];
  for (const m of s.agreement.milestones)
    results.push(
      await market.submitMilestone(s.captain, m.id, submission(m), key()),
    );
  await Promise.all(
    results.map((r) =>
      market.acceptMilestone(s.owner, r.milestone.id, review(r), key()),
    ),
  );
  assert.equal(
    (await market.agreement(s.owner, s.agreement.id)).state,
    "completed",
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT * FROM campus.events WHERE object_id=$1 AND kind='agreement.completed'",
        [s.agreement.id],
      )
    ).rowCount,
    1,
  );
  const t = await scenario(1),
    m = t.agreement.milestones[0],
    first = await market.submitMilestone(t.captain, m.id, submission(m), key());
  const raced = await Promise.allSettled([
    market.acceptMilestone(t.owner, m.id, review(first), key()),
    market.submitMilestone(
      t.captain,
      m.id,
      submission(first.milestone, "Replacement"),
      key(),
    ),
  ]);
  assert.equal(raced.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    raced.find((x) => x.status === "rejected").reason.code,
    "stale_revision",
  );
});
test("raw app SQL cannot activate agreements, add frozen parties/stages, forge work, invitation or another member consent", async () => {
  const s = await scenario(1),
    m = s.agreement.milestones[0];
  const queries = [
    [
      "UPDATE campus.agreements SET state='completed' WHERE id=$1",
      [s.agreement.id],
    ],
    [
      "INSERT INTO campus.agreement_members VALUES($1,$2)",
      [s.agreement.id, s.outsider],
    ],
    [
      "INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable) VALUES($1,2,'Injected',1,'X')",
      [s.agreement.id],
    ],
    [
      "INSERT INTO campus.submissions(milestone_id,author_id,version,content) VALUES($1,$2,1,'Fake')",
      [m.id, s.captain],
    ],
    ["UPDATE campus.milestones SET state='accepted' WHERE id=$1", [m.id]],
    ["UPDATE campus.applications SET state='invited' WHERE id=$1", [s.app.id]],
    [
      "INSERT INTO campus.application_members VALUES($1,$2,true)",
      [s.app.id, s.outsider],
    ],
    [
      "UPDATE campus.application_members SET user_id=$2,confirmed=true WHERE application_id=$1",
      [s.app.id, s.outsider],
    ],
  ];
  for (const [sql, args] of queries)
    await assert.rejects(
      store.as(s.captain, (c) => c.query(sql, args)),
      code("42501"),
    );
  const task = await market.publishTask(s.owner, body(1), key());
  await assert.rejects(
    store.as(s.captain, (c) =>
      c.query(
        "INSERT INTO campus.applications(task_id,applicant_id,proposal,state) VALUES($1,$2,'Forged','invited')",
        [task.id, s.captain],
      ),
    ),
    code("42501"),
  );
  const app = await market.apply(
    s.captain,
    task.id,
    { proposal: "Normal", teamId: null },
    key(),
  );
  await assert.rejects(
    store.as(s.captain, (c) =>
      c.query("SELECT campus.change_application_state($1,'invited')", [app.id]),
    ),
    (e) => e.message === "not_owner",
  );
  await assert.rejects(
    store.as(s.captain, (c) =>
      c.query("SELECT campus.initialize_application_members($1)", [app.id]),
    ),
    (e) => e.message === "invalid_state",
  );
});
test("two captains who are each other’s signed team member can accept different tasks concurrently", async () => {
  const a = await f.user("Captain A"),
    b = await f.user("Captain B"),
    publisher = await f.user("Publisher");
  const apps = [];
  for (const [captain, member] of [
    [a, b],
    [b, a],
  ]) {
    let team = await market.createTeam(
      captain,
      { name: "Mutual collaborators", context: background },
      key(),
    );
    team = await market.inviteMember(
      captain,
      team.id,
      { userId: member, expectedRevision: team.revision },
      key(),
    );
    await market.acceptMembership(
      member,
      team.id,
      { expectedRevision: team.revision },
      key(),
    );
    const task = await market.publishTask(publisher, body(1), key());
    const app = await market.apply(
      captain,
      task.id,
      { proposal: "Both contribute", teamId: team.id },
      key(),
    );
    await market.consentApplication(member, app.id, {}, key());
    await market.inviteApplicant(publisher, app.id, {}, key());
    apps.push([captain, app.id]);
  }
  const agreements = await Promise.all(
    apps.map(([captain, id]) =>
      market.acceptInvitation(captain, id, {}, key()),
    ),
  );
  assert.equal(agreements.length, 2);
  assert.notEqual(agreements[0].id, agreements[1].id);
  for (const agreement of agreements)
    assert.deepEqual(
      (await market.agreement(a, agreement.id)).members
        .map((x) => x.user_id)
        .sort(),
      [a, b].sort(),
    );
});
test("009 to 010 preserves legacy rows and states, backfills only exact links, invents no reviews, and completes only on explicit authorized action", async () => {
  const database = "campus_test_" + key().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(f.config, "migrator"),
  });
  const owner = new pg.Client({
    connectionString: connectionString(f.config, "migrator", database),
  });
  let legacy;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  try {
    await owner.connect();
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../../backend/db/migrations/", import.meta.url),
      names = (await readdir(dir)).filter((x) => /^\d+.*\.sql$/.test(x)).sort();
    for (const name of names.filter((x) => x < "010")) {
      const sql = await readFile(new URL(name, dir), "utf8");
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const publisher = key(),
      captain = key(),
      institution = key();
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'Legacy University',true,'Synthetic only')",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('campus.example.test',$1,true)",
      [institution],
    );
    for (const id of [publisher, captain]) {
      await owner.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,'Legacy user')",
        [id],
      );
      await owner.query(
        "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'campus.example.test',now()+interval '1 year',true)",
        [id, institution],
      );
    }
    const records = [];
    for (const state of ["active", "awaiting_funding"]) {
      const task = key(),
        app = key(),
        agreement = key(),
        milestone = key(),
        work = key();
      records.push({ agreement, milestone, work, state });
      await owner.query(
        "INSERT INTO campus.tasks(id,owner_id,title,category,status) VALUES($1,$2,'Old task','Research','contracted')",
        [task, publisher],
      );
      await owner.query(
        "INSERT INTO campus.applications(id,task_id,applicant_id,proposal,state) VALUES($1,$2,$3,'Old proposal','accepted')",
        [app, task, captain],
      );
      await owner.query(
        "INSERT INTO campus.agreements(id,task_id,application_id,owner_id,captain_id,terms,state) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          agreement,
          task,
          app,
          publisher,
          captain,
          JSON.stringify({ legacy: "Original immutable terms" }),
          state,
        ],
      );
      await owner.query("INSERT INTO campus.agreement_members VALUES($1,$2)", [
        agreement,
        captain,
      ]);
      await owner.query(
        "INSERT INTO campus.milestones(id,agreement_id,position,title,amount_cents,deliverable,state,version) VALUES($1,$2,1,'Legacy phase',100,'Old work','accepted',1)",
        [milestone, agreement],
      );
      await owner.query(
        "INSERT INTO campus.submissions(id,milestone_id,author_id,version,content) VALUES($1,$2,$3,1,'Historical work')",
        [work, milestone, captain],
      );
    }
    const tables = [
        "agreements",
        "agreement_members",
        "milestones",
        "submissions",
      ],
      before = {};
    for (const table of tables)
      before[table] = (
        await owner.query(`SELECT * FROM campus.${table} ORDER BY 1`)
      ).rows;
    assert.equal(await migrate(owner), names.filter((x) => x >= "010").length);
    assert.equal(await migrate(owner), 0);
    for (const table of tables) {
      const rows = (
        await owner.query(`SELECT * FROM campus.${table} ORDER BY 1`)
      ).rows;
      for (const row of rows)
        if (table === "milestones") {
          assert.equal(row.revision, 1);
          const r = records.find((x) => x.milestone === row.id);
          assert.equal(row.latest_submission_id, r.work);
          assert.equal(row.accepted_submission_id, r.work);
          delete row.revision;
          delete row.latest_submission_id;
          delete row.accepted_submission_id;
        }
      assert.deepEqual(rows, before[table]);
    }
    assert.equal(
      (await owner.query("SELECT * FROM campus.milestone_reviews")).rowCount,
      0,
    );
    legacy = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((role) => [
          role,
          connectionString(f.config, role, database),
        ]),
      ),
    );
    const service = createMarket(legacy),
      once = key(),
      active = records[0].agreement;
    const completed = await service.completeAgreement(
      publisher,
      active,
      {},
      once,
    );
    assert.equal(completed.agreement.state, "completed");
    assert.deepEqual(
      await service.completeAgreement(publisher, active, {}, once),
      completed,
    );
    await assert.rejects(
      service.completeAgreement(publisher, records[1].agreement, {}, key()),
      code("funding_required"),
    );
    assert.equal(
      (await owner.query("SELECT * FROM campus.milestone_reviews")).rowCount,
      0,
    );
  } finally {
    if (legacy) await legacy.close();
    await owner.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
