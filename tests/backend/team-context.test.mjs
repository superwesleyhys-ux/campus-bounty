import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { connectionString } from "../../scripts/backend-local.mjs";
import { migrate } from "../../backend/db/migrate.mjs";

const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
test.after(async () => {
  await store.close();
  await f.close();
});
const background = {
  purpose: "Study local water quality",
  activities: "Read papers and compare notes",
  timeCommitment: "One hour each week",
  projectContext: "An optional reading group, not a task amendment",
};
const blank = {
  purpose: "",
  activities: "",
  timeCommitment: "",
  projectContext: "",
};
const rev = (t) => ({ expectedRevision: t.revision });
const target = (t, userId) => ({ ...rev(t), userId });
const input = (t, context = background) => ({ ...rev(t), context });
const code = (name) => (e) => e.code === name;
async function people() {
  const ids = [];
  for (const name of ["Captain", "Peer", "Outsider"])
    ids.push(await f.user(name));
  return ids;
}
const create = (actor, context = background) =>
  market.createTeam(actor, { name: "Context test", context }, key());
const events = async (id) =>
  (
    await f.owner.query(
      "SELECT * FROM campus.team_context_events WHERE team_id=$1 ORDER BY revision",
      [id],
    )
  ).rows;

test("context creation trims four fields, legacy drafts are blank, and supplied input is strict without partial writes", async () => {
  const [a] = await people();
  const t = await create(
    a,
    Object.fromEntries(
      Object.entries(background).map(([k, v]) => [k, ` \t${v}\n `]),
    ),
  );
  assert.deepEqual(t.context, background);
  assert.equal(t.revision, 1);
  assert.equal((await events(t.id)).length, 1);
  assert.deepEqual(
    (await market.createTeam(a, { name: "Legacy" }, key())).context,
    blank,
  );
  assert.equal("context" in (await market.teams(a))[0], false);
  const invalid = [
    null,
    {},
    blank,
    { ...background, extra: true },
    { ...background, purpose: " \n " },
    { ...background, activities: 42 },
    { ...background, purpose: "x".repeat(1001) },
    { ...background, activities: "x".repeat(1501) },
    { ...background, timeCommitment: "x".repeat(501) },
    { ...background, projectContext: "x".repeat(1501) },
  ];
  const { projectContext, ...missing } = background;
  invalid.push(missing);
  const before = (await market.teams(a)).length;
  for (const context of invalid) {
    await assert.rejects(create(a, context), code("invalid_input"));
    await assert.rejects(
      market.updateTeamContext(a, t.id, input(t, context), key()),
      code("invalid_input"),
    );
  }
  assert.equal((await market.teams(a)).length, before);
  assert.deepEqual((await market.team(a, t.id)).context, background);
  const max = {
    purpose: "x".repeat(1000),
    activities: "x".repeat(1500),
    timeCommitment: "x".repeat(500),
    projectContext: "x".repeat(1500),
  };
  assert.deepEqual((await create(a, max)).context, max);
  assert.equal(
    (await create(a, { ...background, projectContext: "   " })).context
      .projectContext,
    "",
  );
});

test("only current invited/accepted users see current context; former users and outsiders cannot bypass with SQL or DTOs", async () => {
  const [a, b, c] = await people();
  let t = await create(a);
  t = await market.inviteMember(a, t.id, target(t, b), key());
  assert.deepEqual((await market.team(b, t.id)).context, background);
  assert.equal(
    (
      await store.as(b, (db) =>
        db.query("SELECT * FROM campus.team_contexts WHERE team_id=$1", [t.id]),
      )
    ).rowCount,
    1,
  );
  await assert.rejects(market.team(c, t.id), code("not_found"));
  assert.equal(
    (
      await store.as(c, (db) =>
        db.query("SELECT * FROM campus.team_contexts WHERE team_id=$1", [t.id]),
      )
    ).rowCount,
    0,
  );
  for (const ending of ["decline", "revoke", "leave", "remove"]) {
    if (ending !== "decline")
      t = await market.inviteMember(a, t.id, target(t, b), key());
    if (["leave", "remove"].includes(ending))
      t = await market.acceptMembership(b, t.id, rev(t), key());
    if (ending === "decline")
      t = await market.declineMembership(b, t.id, rev(t), key());
    if (ending === "revoke")
      t = await market.revokeInvitation(a, t.id, b, rev(t), key());
    if (ending === "leave") t = await market.leaveTeam(b, t.id, rev(t), key());
    if (ending === "remove")
      t = await market.removeMember(a, t.id, b, rev(t), key());
    assert.equal((await market.team(b, t.id)).context, null);
    assert.equal(
      (
        await store.as(b, (db) =>
          db.query("SELECT * FROM campus.team_contexts WHERE team_id=$1", [
            t.id,
          ]),
        )
      ).rowCount,
      0,
    );
  }
  for (const actor of [a, b, c]) {
    await assert.rejects(
      store.as(actor, (db) =>
        db.query("SELECT * FROM campus.team_context_events WHERE team_id=$1", [
          t.id,
        ]),
      ),
      code("42501"),
    );
    await assert.rejects(
      store.as(actor, (db) =>
        db.query(
          "UPDATE campus.team_contexts SET purpose='Bypassed' WHERE team_id=$1",
          [t.id],
        ),
      ),
      code("42501"),
    );
  }
});

test("new invitations require complete background while legacy pending invitations can accept but cannot be reissued blank", async () => {
  const [a, b] = await people();
  let t = await market.createTeam(a, { name: "Legacy draft" }, key());
  await assert.rejects(
    market.inviteMember(a, t.id, target(t, b), key()),
    code("team_context_required"),
  );
  await assert.rejects(
    store.as(a, (db) =>
      db.query("SELECT campus.change_team($1,'invite',$2,$3)", [
        t.id,
        b,
        t.revision,
      ]),
    ),
    (e) => e.message === "team_context_required",
  );
  assert.equal((await market.team(a, t.id)).revision, 1);
  t = await market.updateTeamContext(a, t.id, input(t), key());
  t = await market.inviteMember(a, t.id, target(t, b), key());
  // Fixture-owner-only simulation of a pending invitation from before 009.
  await f.owner.query(
    "UPDATE campus.team_contexts SET purpose='',activities='',time_commitment='',project_context='' WHERE team_id=$1",
    [t.id],
  );
  assert.deepEqual((await market.team(b, t.id)).context, blank);
  t = await market.acceptMembership(b, t.id, rev(t), key());
  assert.equal(t.own_state, "accepted");
  t = await market.leaveTeam(b, t.id, rev(t), key());
  await assert.rejects(
    market.inviteMember(a, t.id, target(t, b), key()),
    code("team_context_required"),
  );
});

test("context revision invalidates stale acceptance and serialized concurrent edit/accept admits one operation", async () => {
  const [a, b] = await people();
  let t = await create(a);
  t = await market.inviteMember(a, t.id, target(t, b), key());
  const old = t;
  t = await market.updateTeamContext(
    a,
    t.id,
    input(t, { ...background, timeCommitment: "Two hours weekly" }),
    key(),
  );
  assert.equal(t.revision, old.revision + 1);
  await assert.rejects(
    market.acceptMembership(b, t.id, rev(old), key()),
    code("team_revision_changed"),
  );
  assert.equal((await market.team(b, t.id)).own_state, "invited");
  const race = await Promise.allSettled([
    market.updateTeamContext(
      a,
      t.id,
      input(t, { ...background, purpose: "A changed scope" }),
      key(),
    ),
    market.acceptMembership(b, t.id, rev(t), key()),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    race.find((r) => r.status === "rejected").reason.code,
    "team_revision_changed",
  );
  assert.equal((await market.team(a, t.id)).revision, t.revision + 1);
});

test("expired or restricted captains may edit; other members, locked actors and archived teams cannot", async () => {
  const [a, b, c] = await people();
  let t = await create(a);
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.acceptMembership(b, t.id, rev(t), key());
  await assert.rejects(
    market.updateTeamContext(b, t.id, input(t), key()),
    code("not_owner"),
  );
  await assert.rejects(
    market.updateTeamContext(c, t.id, input(t), key()),
    code("not_found"),
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [a],
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day',student_valid_until=now()-interval '1 day' WHERE user_id=$1",
    [a],
  );
  t = await market.updateTeamContext(
    a,
    t.id,
    input(t, { ...background, activities: "Updated activities" }),
    key(),
  );
  t = await market.transferCaptain(a, t.id, target(t, b), key());
  await assert.rejects(
    market.updateTeamContext(a, t.id, input(t), key()),
    code("not_owner"),
  );
  t = await market.updateTeamContext(b, t.id, input(t), key());
  t = await market.removeMember(b, t.id, a, rev(t), key());
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [b],
  );
  await assert.rejects(
    market.updateTeamContext(b, t.id, input(t), key()),
    code("account_locked"),
  );
  await assert.rejects(
    store.as(b, (db) =>
      db.query("SELECT campus.set_team_context($1,$2,$3)", [
        t.id,
        t.revision,
        JSON.stringify(background),
      ]),
    ),
    (e) => e.message === "account_locked",
  );
  assert.equal(
    (
      await store.as(b, (db) =>
        db.query("SELECT * FROM campus.team_contexts WHERE team_id=$1", [t.id]),
      )
    ).rowCount,
    0,
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='active' WHERE id=$1",
    [b],
  );
  t = await market.archiveTeam(b, t.id, rev(t), key());
  assert.deepEqual(t.context, background);
  await assert.rejects(
    market.updateTeamContext(
      b,
      t.id,
      input(t, { ...background, purpose: "Archived change" }),
      key(),
    ),
    code("team_archived"),
  );
});

test("idempotent context replay returns latest authorized state without reverting later edits or leaking after exit", async () => {
  const [a, b] = await people();
  let t = await create(a);
  const original = input(t, { ...background, purpose: "First edit" }),
    once = key();
  t = await market.updateTeamContext(a, t.id, original, once);
  const changed = { ...background, purpose: "Second edit" };
  t = await market.updateTeamContext(a, t.id, input(t, changed), key());
  const replay = await market.updateTeamContext(a, t.id, original, once);
  assert.deepEqual(replay.context, changed);
  assert.equal(replay.revision, t.revision);
  await assert.rejects(
    market.updateTeamContext(
      a,
      t.id,
      { ...original, context: background },
      once,
    ),
    code("idempotency_conflict"),
  );
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.acceptMembership(b, t.id, rev(t), key());
  t = await market.transferCaptain(a, t.id, target(t, b), key());
  assert.equal(
    (await market.updateTeamContext(a, t.id, original, once)).owner_id,
    b,
  );
  t = await market.leaveTeam(a, t.id, rev(t), key());
  const departed = await market.updateTeamContext(a, t.id, original, once);
  assert.equal(departed.context, null);
  assert.equal(departed.owner_id, null);
  assert.equal(departed.own_state, "left");
  assert.equal((await events(t.id)).length, 3);
});

test("actual context edits are audited once, same-value replacement is a no-op, and history cannot be rewritten", async () => {
  const [a] = await people();
  let t = await create(a);
  const noop = await market.updateTeamContext(a, t.id, input(t), key());
  assert.equal(noop.revision, t.revision);
  assert.equal((await events(t.id)).length, 1);
  const body = input(t, {
      ...background,
      projectContext: "A new current context",
    }),
    once = key();
  t = await market.updateTeamContext(a, t.id, body, once);
  await market.updateTeamContext(a, t.id, body, once);
  await store.as(a, (db) =>
    db.query("SELECT campus.set_team_context($1,$2,$3)", [
      t.id,
      t.revision,
      JSON.stringify({ ...background, purpose: "Direct authorized edit" }),
    ]),
  );
  const history = await events(t.id);
  assert.deepEqual(
    history.map((e) => e.action),
    ["create", "update", "update"],
  );
  assert.equal(history[0].purpose, background.purpose);
  assert.equal(history[2].purpose, "Direct authorized edit");
  assert.equal(
    (
      await f.owner.query(
        "SELECT * FROM campus.audit WHERE object_id=$1 AND action='team.context'",
        [t.id],
      )
    ).rowCount,
    2,
  );
  for (const sql of [
    "UPDATE campus.team_context_events SET purpose='Erased' WHERE team_id=$1",
    "DELETE FROM campus.team_context_events WHERE team_id=$1",
  ]) {
    await assert.rejects(f.owner.query(sql, [t.id]), code("23514"));
    await assert.rejects(
      store.as(a, (db) => db.query(sql, [t.id])),
      code("42501"),
    );
  }
});

test("definers validate raw SQL shape and bounds and are unavailable to auth/worker roles", async () => {
  const [a] = await people();
  const t = await create(a);
  for (const context of [
    { ...background, purpose: "" },
    { ...background, extra: "x" },
    { purpose: background.purpose },
    { ...background, timeCommitment: "x".repeat(501) },
    { ...background, projectContext: null },
  ]) {
    await assert.rejects(
      store.as(a, (db) =>
        db.query("SELECT campus.set_team_context($1,$2,$3)", [
          t.id,
          t.revision,
          JSON.stringify(context),
        ]),
      ),
      (e) => e.message === "invalid_input",
    );
  }
  for (const pool of [store.auth, store.worker]) {
    await assert.rejects(
      pool.query("SELECT campus.set_team_context($1,$2,$3)", [
        t.id,
        t.revision,
        JSON.stringify(background),
      ]),
      code("42501"),
    );
    await assert.rejects(
      pool.query("SELECT campus.create_team_with_context('No access',$1)", [
        JSON.stringify(background),
      ]),
      code("42501"),
    );
  }
  await assert.rejects(
    store.as(a, (db) =>
      db.query("SELECT campus.normalize_team_context($1)", [
        JSON.stringify(background),
      ]),
    ),
    code("42501"),
  );
  assert.equal((await market.team(a, t.id)).revision, t.revision);
});

test("background changes preserve existing application participants, agreement terms and recorded captain", async () => {
  const [a, b, publisher] = await people();
  let t = await create(a);
  t = await market.inviteMember(a, t.id, target(t, b), key());
  t = await market.acceptMembership(b, t.id, rev(t), key());
  const task = await market.publishTask(
    publisher,
    {
      title: "Keep agreed terms",
      category: "Research",
      description: "Synthetic research",
      rewardCents: 100,
      milestones: [
        { title: "Notes", amountCents: 100, deliverable: "One-page summary" },
      ],
    },
    key(),
  );
  const app = await market.apply(
    a,
    task.id,
    { proposal: "Original plan", teamId: t.id },
    key(),
  );
  await market.consentApplication(b, app.id, {}, key());
  await market.inviteApplicant(publisher, app.id, {}, key());
  const agreement = await market.acceptInvitation(a, app.id, {}, key());
  const before = await market.agreement(a, agreement.id);
  const participants = (
    await f.owner.query(
      "SELECT * FROM campus.application_members WHERE application_id=$1 ORDER BY user_id",
      [app.id],
    )
  ).rows;
  t = await market.updateTeamContext(
    a,
    t.id,
    input(t, {
      ...background,
      purpose: "A different future activity",
      timeCommitment: "Three hours weekly",
    }),
    key(),
  );
  const after = await market.agreement(a, agreement.id);
  assert.deepEqual(after.terms, before.terms);
  assert.deepEqual(after.members, before.members);
  assert.equal(after.captain_id, before.captain_id);
  assert.deepEqual(
    (
      await f.owner.query(
        "SELECT * FROM campus.application_members WHERE application_id=$1 ORDER BY user_id",
        [app.id],
      )
    ).rows,
    participants,
  );
});

test("008 to 009 migration preserves existing pending invitations, revisions and signed terms while backfilling private blank context", async () => {
  const database = "campus_test_" + key().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(f.config, "migrator"),
  });
  const owner = new pg.Client({
    connectionString: connectionString(f.config, "migrator", database),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  let legacyStore;
  try {
    await owner.connect();
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../../backend/db/migrations/", import.meta.url);
    const names = (await readdir(directory))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort();
    for (const name of names.filter((n) => n < "009_team_context.sql")) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const a = key(),
      b = key(),
      publisher = key(),
      institution = key(),
      task = key(),
      application = key(),
      agreement = key();
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'Legacy University',true,'Synthetic migration test')",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('campus.example.test',$1,true)",
      [institution],
    );
    for (const [id, name] of [
      [a, "Legacy captain"],
      [b, "Pending member"],
      [publisher, "Publisher"],
    ]) {
      await owner.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
        [id, name],
      );
      await owner.query(
        "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'campus.example.test',now()+interval '1 year',true)",
        [id, institution],
      );
    }
    legacyStore = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((role) => [
          role,
          connectionString(f.config, role, database),
        ]),
      ),
    );
    const team = (
      await legacyStore.as(a, (db) =>
        db.query("SELECT campus.create_team('Existing group') AS id"),
      )
    ).rows[0].id;
    await legacyStore.as(a, (db) =>
      db.query("SELECT campus.change_team($1,'invite',$2,1)", [team, b]),
    );
    const terms = {
      taskTitle: "Original signed promise",
      deliverable: "Existing scoped notes",
      privateMarker: "Do not amend",
    };
    await owner.query(
      "INSERT INTO campus.tasks(id,owner_id,title,category,status) VALUES($1,$2,'Legacy promise','Research','contracted')",
      [task, publisher],
    );
    await owner.query(
      "INSERT INTO campus.applications(id,task_id,applicant_id,team_id,proposal,state) VALUES($1,$2,$3,$4,'Original proposal','accepted')",
      [application, task, a, team],
    );
    await owner.query(
      "INSERT INTO campus.application_members(application_id,user_id,confirmed) VALUES($1,$2,true)",
      [application, a],
    );
    await owner.query(
      "INSERT INTO campus.agreements(id,task_id,application_id,owner_id,captain_id,terms) VALUES($1,$2,$3,$4,$5,$6)",
      [agreement, task, application, publisher, a, JSON.stringify(terms)],
    );
    const pendingBefore = (
      await owner.query(
        "SELECT * FROM campus.team_members WHERE team_id=$1 ORDER BY user_id",
        [team],
      )
    ).rows;
    const applied = await migrate(owner);
    assert.equal(
      applied,
      names.filter((n) => n >= "009_team_context.sql").length,
    );
    assert.equal(await migrate(owner), 0);
    assert.deepEqual(
      (
        await owner.query(
          "SELECT * FROM campus.team_members WHERE team_id=$1 ORDER BY user_id",
          [team],
        )
      ).rows,
      pendingBefore,
    );
    assert.equal(
      (
        await owner.query("SELECT revision FROM campus.teams WHERE id=$1", [
          team,
        ])
      ).rows[0].revision,
      2,
    );
    assert.deepEqual(
      (
        await owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
          agreement,
        ])
      ).rows[0].terms,
      terms,
    );
    const legacyMarket = createMarket(legacyStore);
    assert.deepEqual((await legacyMarket.team(b, team)).context, blank);
    const accepted = await legacyMarket.acceptMembership(
      b,
      team,
      { expectedRevision: 2 },
      key(),
    );
    assert.equal(accepted.own_state, "accepted");
    assert.equal(accepted.revision, 3);
    assert.deepEqual(accepted.context, blank);
    const history = (
      await owner.query(
        "SELECT action,revision,purpose FROM campus.team_context_events WHERE team_id=$1",
        [team],
      )
    ).rows;
    assert.deepEqual(history, [
      { action: "backfill", revision: 2, purpose: "" },
    ]);
  } finally {
    if (legacyStore) await legacyStore.close();
    await owner.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
