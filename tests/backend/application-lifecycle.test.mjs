const teamBackground = {
  purpose: "Synthetic research",
  activities: "Read and discuss sources",
  timeCommitment: "One hour weekly",
  projectContext: "",
};
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
import { connectionString } from "../../scripts/backend-local.mjs";

const f = await fixture();
const store = createStore(f.urls);
const market = createMarket(store);
const owner = await f.user("Publisher");
const applicant = await f.user("Applicant");
const peer = await f.user("Team member");
const other = await f.user("Other applicant");
const outsider = await f.user("Outsider");
const key = () => randomUUID();
const body = {
  title: "Application lifecycle research",
  category: "Research",
  description: "Preserve every proposal and signed agreement.",
  rewardCents: 12000,
  dueDate: "2027-06-05",
  milestones: [
    {
      title: "Report",
      amountCents: 12000,
      deliverable: "Report",
      acceptanceCriteria: "Include sources",
    },
  ],
};
const publish = () => market.publishTask(owner, body, key());
const apply = (
  task,
  actor = applicant,
  teamId = null,
  proposal = "My proposal",
) => market.apply(actor, task.id, { proposal, teamId }, key());
const state = async (id) =>
  (
    await f.owner.query("SELECT state FROM campus.applications WHERE id=$1", [
      id,
    ])
  ).rows[0].state;
const absentAgreement = async (taskId) =>
  assert.equal(
    (
      await f.owner.query("SELECT id FROM campus.agreements WHERE task_id=$1", [
        taskId,
      ])
    ).rowCount,
    0,
  );

test.after(async () => {
  await store.close();
  await f.close();
});

test("withdrawal and publisher rejection enforce actors, strict input, retry and preserved history", async () => {
  const task = await publish();
  const firstKey = key();
  const firstBody = { proposal: "First unchanged proposal", teamId: null };
  const first = await market.apply(applicant, task.id, firstBody, firstKey);
  await assert.rejects(
    market.withdrawApplication(outsider, first.id, {}, key()),
    { code: "not_found" },
  );
  await assert.rejects(market.withdrawApplication(owner, first.id, {}, key()), {
    code: "not_applicant",
  });
  await assert.rejects(
    market.rejectApplication(applicant, first.id, {}, key()),
    { code: "not_owner" },
  );
  await assert.rejects(
    market.rejectApplication(outsider, first.id, {}, key()),
    { code: "not_found" },
  );
  await assert.rejects(
    market.withdrawApplication(
      applicant,
      first.id,
      { state: "accepted" },
      key(),
    ),
    { status: 422 },
  );
  const withdrawalKey = key();
  const withdrawn = await market.withdrawApplication(
    applicant,
    first.id,
    {},
    withdrawalKey,
  );
  assert.deepEqual(withdrawn, { id: first.id, state: "withdrawn" });
  assert.deepEqual(
    await market.withdrawApplication(applicant, first.id, {}, withdrawalKey),
    withdrawn,
  );
  assert.deepEqual(
    await market.withdrawApplication(applicant, first.id, {}, key()),
    withdrawn,
  );
  await assert.rejects(market.rejectApplication(owner, first.id, {}, key()), {
    code: "invalid_state",
  });
  await assert.rejects(market.inviteApplicant(owner, first.id, {}, key()), {
    code: "invalid_state",
  });
  await assert.rejects(
    market.consentApplication(applicant, first.id, {}, key()),
    { code: "invalid_state" },
  );
  await assert.rejects(
    market.acceptInvitation(applicant, first.id, {}, key()),
    { code: "invalid_state" },
  );
  const replay = await market.apply(applicant, task.id, firstBody, firstKey);
  assert.equal(
    replay.id,
    first.id,
    "old command receipt stays historical; it cannot create another application",
  );
  assert.equal(await state(first.id), "withdrawn");
  const second = await apply(task, applicant, null, "Fresh application");
  assert.notEqual(second.id, first.id);
  const outcomes = await Promise.all([
    market.rejectApplication(owner, second.id, {}, key()),
    market.rejectApplication(owner, second.id, {}, key()),
  ]);
  assert.ok(outcomes.every((result) => result.state === "declined"));
  const third = await apply(task, applicant, null, "Third application");
  await assert.rejects(apply(task), { code: "already_applied" });
  const history = await market.myApplications(applicant);
  assert.equal(history.filter((a) => a.task_id === task.id).length, 3);
  assert.equal(
    history.find((a) => a.id === first.id).proposal,
    firstBody.proposal,
  );
  assert.deepEqual(
    history.find((a) => a.id === first.id).members.map((m) => m.user_id),
    [applicant],
  );
  assert.equal(await state(third.id), "applied");
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.applications SET proposal='Replaced history' WHERE id=$1",
      [first.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    f.owner.query(
      "UPDATE campus.applications SET state='applied' WHERE id=$1",
      [first.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    f.owner.query(
      "INSERT INTO campus.applications(task_id,applicant_id,proposal) VALUES($1,$2,'Duplicate')",
      [task.id, applicant],
    ),
    { code: "23505" },
  );
  await absentAgreement(task.id);
});

test("invited applicants can decline; team peers cannot withdraw a captain's proposal", async () => {
  const team = await market.createTeam(
    applicant,
    { name: "Lifecycle team", context: teamBackground },
    key(),
  );
  await market.inviteMember(
    applicant,
    team.id,
    { userId: peer, expectedRevision: team.revision },
    key(),
  );
  await market.acceptMembership(
    peer,
    team.id,
    { expectedRevision: team.revision + 1 },
    key(),
  );
  const task = await publish();
  const a = await apply(task, applicant, team.id);
  await assert.rejects(market.withdrawApplication(peer, a.id, {}, key()), {
    code: "not_applicant",
  });
  await market.consentApplication(peer, a.id, {}, key());
  await market.inviteApplicant(owner, a.id, {}, key());
  assert.equal(
    (await market.withdrawApplication(applicant, a.id, {}, key())).state,
    "withdrawn",
  );
  assert.equal(
    (await market.myApplications(peer)).find((v) => v.id === a.id).state,
    "withdrawn",
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int AS count FROM campus.application_members WHERE application_id=$1",
        [a.id],
      )
    ).rows[0].count,
    2,
  );
  const b = await apply(task, applicant, team.id);
  await assert.rejects(market.inviteApplicant(owner, b.id, {}, key()), {
    code: "team_consent_required",
  });
  await market.consentApplication(peer, b.id, {}, key());
  await market.inviteApplicant(owner, b.id, {}, key());
  assert.equal(
    (await market.rejectApplication(owner, b.id, {}, key())).state,
    "declined",
  );
});

test("acceptance supersedes every other live application atomically without exposing their proposals", async () => {
  const task = await publish();
  const winner = await apply(task);
  const invited = await apply(task, other);
  const pending = await apply(task, peer);
  const withdrawn = await apply(task, outsider);
  await market.withdrawApplication(outsider, withdrawn.id, {}, key());
  await market.inviteApplicant(owner, winner.id, {}, key());
  await market.inviteApplicant(owner, invited.id, {}, key());
  await assert.rejects(
    store.as(outsider, (c) =>
      c.query("SELECT campus.supersede_other_applications($1)", [winner.id]),
    ),
    { code: "42501" },
  );
  assert.equal(await state(invited.id), "invited");
  const agreement = await market.acceptInvitation(
    applicant,
    winner.id,
    {},
    key(),
  );
  assert.equal(agreement.state, "awaiting_funding");
  assert.equal(agreement.terms.dueDate, body.dueDate);
  assert.equal(
    agreement.terms.milestones[0].acceptance_criteria,
    "Include sources",
  );
  assert.equal(await state(winner.id), "accepted");
  assert.equal(await state(invited.id), "superseded");
  assert.equal(await state(pending.id), "superseded");
  assert.equal(await state(withdrawn.id), "withdrawn");
  assert.equal(
    (await market.applications(applicant, task.id)).length,
    1,
    "the accepting applicant cannot read competitors",
  );
  assert.equal((await market.applications(owner, task.id)).length, 4);
  assert.equal(
    (await market.acceptInvitation(applicant, winner.id, {}, key())).id,
    agreement.id,
  );
  for (const command of [
    () => market.withdrawApplication(applicant, winner.id, {}, key()),
    () => market.rejectApplication(owner, winner.id, {}, key()),
  ])
    await assert.rejects(command(), { code: "invalid_state" });
  await assert.rejects(market.acceptInvitation(other, invited.id, {}, key()), {
    code: "task_contracted",
  });
  await assert.rejects(apply(task, other), { code: "invalid_state" });
  assert.deepEqual(
    (await market.agreement(applicant, agreement.id)).terms,
    agreement.terms,
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int AS count FROM campus.events WHERE kind='application.superseded' AND object_id=ANY($1::uuid[])",
        [[invited.id, pending.id]],
      )
    ).rows[0].count,
    2,
  );
});

async function stopAtTaskLock(taskId, command, mutation) {
  let running;
  await f.owner.query("BEGIN");
  try {
    await f.owner.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["task:" + taskId],
    );
    running = command().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      await f.owner.query("SELECT pg_stat_clear_snapshot()");
      const waiting = await f.owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_app' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'",
      );
      if (waiting.rowCount) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      blocked,
      true,
      "observe the command blocked on the actual task lock",
    );
    await mutation();
    await f.owner.query("COMMIT");
  } finally {
    await f.owner.query("ROLLBACK");
  }
  return running;
}

test("accept and consent re-read application state after task-lock waits", async () => {
  const task = await publish();
  const a = await apply(task);
  await market.inviteApplicant(owner, a.id, {}, key());
  const accepted = await stopAtTaskLock(
    task.id,
    () => market.acceptInvitation(applicant, a.id, {}, key()),
    () =>
      f.owner.query(
        "UPDATE campus.applications SET state='withdrawn' WHERE id=$1",
        [a.id],
      ),
  );
  assert.equal(accepted.error?.code, "invalid_state");
  await absentAgreement(task.id);
  const team = await market.createTeam(
    applicant,
    { name: "Consent race", context: teamBackground },
    key(),
  );
  await market.inviteMember(
    applicant,
    team.id,
    { userId: peer, expectedRevision: team.revision },
    key(),
  );
  await market.acceptMembership(
    peer,
    team.id,
    { expectedRevision: team.revision + 1 },
    key(),
  );
  const b = await apply(task, applicant, team.id);
  const consented = await stopAtTaskLock(
    task.id,
    () => market.consentApplication(peer, b.id, {}, key()),
    () =>
      f.owner.query(
        "UPDATE campus.applications SET state='declined' WHERE id=$1",
        [b.id],
      ),
  );
  assert.equal(consented.error?.code, "invalid_state");
  assert.equal(
    (
      await f.owner.query(
        "SELECT confirmed FROM campus.application_members WHERE application_id=$1 AND user_id=$2",
        [b.id, peer],
      )
    ).rows[0].confirmed,
    false,
  );
});

test("withdraw versus invite, accept versus reject and concurrent reapplication preserve one outcome", async () => {
  const task = await publish();
  const a = await apply(task);
  const inviteRace = await Promise.allSettled([
    market.withdrawApplication(applicant, a.id, {}, key()),
    market.inviteApplicant(owner, a.id, {}, key()),
  ]);
  assert.equal(inviteRace[0].status, "fulfilled");
  assert.equal(await state(a.id), "withdrawn");
  if (inviteRace[1].status === "rejected")
    assert.equal(inviteRace[1].reason.code, "invalid_state");
  const reapplied = await Promise.allSettled([apply(task), apply(task)]);
  assert.equal(reapplied.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(
    reapplied.find((v) => v.status === "rejected").reason.code,
    "already_applied",
  );
  const b = reapplied.find((v) => v.status === "fulfilled").value;
  await market.inviteApplicant(owner, b.id, {}, key());
  const race = await Promise.allSettled([
    market.acceptInvitation(applicant, b.id, {}, key()),
    market.rejectApplication(owner, b.id, {}, key()),
  ]);
  assert.equal(race.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(
    race.find((v) => v.status === "rejected").reason.code,
    "invalid_state",
  );
  const current = await state(b.id);
  assert.ok(["accepted", "declined"].includes(current));
  assert.equal(
    (
      await f.owner.query("SELECT id FROM campus.agreements WHERE task_id=$1", [
        task.id,
      ])
    ).rowCount,
    current === "accepted" ? 1 : 0,
  );
});

test("forward upgrade preserves signed terms, memberships and receipts while ending old competing invitations", async () => {
  const database =
    "campus_application_upgrade_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(f.config, "migrator"),
  });
  const legacy = new pg.Client({
    connectionString: connectionString(f.config, "migrator", database),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  try {
    await legacy.connect();
    await legacy.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../../backend/db/migrations/", import.meta.url);
    const all = (await readdir(directory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const before = all.filter((name) => name < "005_application_lifecycle.sql");
    for (const name of before) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await legacy.query(sql);
      await legacy.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const publisher = key(),
      winner = key(),
      competitor = key(),
      taskId = key(),
      winnerApp = key(),
      competitorApp = key(),
      agreementId = key();
    const terms = {
      taskTitle: "Legacy signed task",
      dueDate: "2027-01-02",
      customOriginalField: "untouched",
    };
    await legacy.query(
      "INSERT INTO campus.users(id,display_name) VALUES($1,'Publisher'),($2,'Winner'),($3,'Competitor')",
      [publisher, winner, competitor],
    );
    await legacy.query(
      "INSERT INTO campus.tasks(id,owner_id,title,category,status) VALUES($1,$2,'Legacy signed task','Research','contracted')",
      [taskId, publisher],
    );
    await legacy.query(
      "INSERT INTO campus.applications(id,task_id,applicant_id,proposal,state) VALUES($1,$2,$3,'Signed proposal','accepted'),($4,$2,$5,'Unselected proposal','invited')",
      [winnerApp, taskId, winner, competitorApp, competitor],
    );
    await legacy.query(
      "INSERT INTO campus.application_members VALUES($1,$2,true),($3,$4,true)",
      [winnerApp, winner, competitorApp, competitor],
    );
    await legacy.query(
      "INSERT INTO campus.agreements(id,task_id,application_id,owner_id,captain_id,terms) VALUES($1,$2,$3,$4,$5,$6)",
      [
        agreementId,
        taskId,
        winnerApp,
        publisher,
        winner,
        JSON.stringify(terms),
      ],
    );
    const receipt = { id: competitorApp, state: "invited" };
    await legacy.query(
      "INSERT INTO campus.idempotency(actor_id,operation,key,request_hash,response) VALUES($1,'application.invite','legacy-invitation','frozen',$2)",
      [publisher, JSON.stringify(receipt)],
    );
    assert.equal(await migrate(legacy), all.length - before.length);
    assert.equal(await migrate(legacy), 0);
    assert.deepEqual(
      (
        await legacy.query(
          "SELECT id,state,proposal FROM campus.applications ORDER BY proposal",
        )
      ).rows,
      [
        { id: winnerApp, state: "accepted", proposal: "Signed proposal" },
        {
          id: competitorApp,
          state: "superseded",
          proposal: "Unselected proposal",
        },
      ],
    );
    assert.deepEqual(
      (
        await legacy.query("SELECT terms FROM campus.agreements WHERE id=$1", [
          agreementId,
        ])
      ).rows[0].terms,
      terms,
    );
    assert.deepEqual(
      (await legacy.query("SELECT response FROM campus.idempotency")).rows[0]
        .response,
      receipt,
    );
    assert.equal(
      (
        await legacy.query(
          "SELECT count(*)::int AS count FROM campus.application_members",
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await legacy.query(
          "SELECT count(*)::int AS count FROM campus.events WHERE kind='application.superseded'",
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await legacy.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
