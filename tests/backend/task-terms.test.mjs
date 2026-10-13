import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { fixture } from "./fixture.mjs";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
import { createStore, idempotent } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { taskModule, taskSchema } from "../../backend/modules/tasks.mjs";

const body = {
  title: "Long-term campus survey",
  category: "Research",
  description: "Document the survey results and methods.",
  rewardCents: 10000,
  milestones: [
    { title: "Survey", amountCents: 4000, deliverable: "Dataset" },
    { title: "Report", amountCents: 6000, deliverable: "Written analysis" },
  ],
};
const key = () => randomUUID();
const invalid = (promise) =>
  assert.rejects(promise, (error) => error.code === "invalid_input");

test("calendar dates and acceptance criteria validate before writes without changing legacy payloads", async () => {
  const boundary = new Error("database boundary"),
    tasks = taskModule({
      as() {
        throw boundary;
      },
    });
  assert.deepEqual(taskSchema.parse(body), body);
  for (const dueDate of [
    "",
    " ",
    "2026-2-01",
    "2026-02-29",
    "2026-04-31",
    "0000-01-01",
    "0001-01-01",
    "0999-12-31",
    "10000-01-01",
    "2026-10-12T00:00:00Z",
    "2026-10-12 ",
    20261012,
  ])
    await invalid(tasks.publishTask(key(), { ...body, dueDate }, key()));
  for (const acceptanceCriteria of ["", " \n\t ", "a".repeat(10001), 42])
    await invalid(
      tasks.publishTask(
        key(),
        {
          ...body,
          milestones: [
            { ...body.milestones[0], amountCents: 10000, acceptanceCriteria },
          ],
        },
        key(),
      ),
    );
  for (const dueDate of [
    null,
    "1000-01-01",
    "2020-01-01",
    "2028-02-29",
    "9999-12-31",
  ])
    await assert.rejects(
      tasks.publishTask(key(), { ...body, dueDate }, key()),
      (error) => error === boundary,
    );
  const parsed = taskSchema.parse({
    ...body,
    milestones: [
      {
        ...body.milestones[0],
        acceptanceCriteria: "  Include all measured samples.\n  ",
      },
    ],
  });
  assert.equal(
    parsed.milestones[0].acceptanceCriteria,
    "Include all measured samples.",
  );
});

test("new terms round-trip through catalog, saved task and private immutable agreement", async () => {
  const f = await fixture(),
    store = createStore(f.urls),
    market = createMarket({
      as: (actor, fn) =>
        store.as(actor, async (c) => {
          // Calendar-day output must not depend on database display conventions
          // or the time zone used by the connection serving this request.
          await c.query("SET LOCAL DateStyle TO 'SQL, DMY'");
          await c.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
          return fn(c);
        }),
    });
  try {
    const owner = await f.user("Publisher"),
      student = await f.user("Applicant"),
      stranger = await f.user("Unrelated member");
    const input = {
      ...body,
      dueDate: "2028-02-29",
      milestones: body.milestones.map((m, index) => ({
        ...m,
        acceptanceCriteria: `  Criterion ${index + 1}: include reproducible methods.  `,
      })),
    };
    const requestKey = key();
    const published = await market.publishTask(owner, input, requestKey);
    assert.equal(published.due_date, input.dueDate);
    assert.deepEqual(
      await market.publishTask(owner, input, requestKey),
      published,
    );
    await assert.rejects(
      market.publishTask(
        owner,
        { ...input, dueDate: "2028-03-01" },
        requestKey,
      ),
      (error) => error.code === "idempotency_conflict",
    );
    await assert.rejects(
      market.publishTask(
        owner,
        {
          ...input,
          milestones: input.milestones.map((m) => ({
            ...m,
            acceptanceCriteria: "Changed criteria",
          })),
        },
        requestKey,
      ),
      (error) => error.code === "idempotency_conflict",
    );
    const detail = await market.task(student, published.id);
    assert.equal(detail.due_date, input.dueDate);
    assert.deepEqual(
      detail.milestones.map((m) => m.acceptance_criteria),
      input.milestones.map((m) => m.acceptanceCriteria.trim()),
    );
    assert.equal(
      (await market.tasks(student, {})).items[0].due_date,
      input.dueDate,
    );
    await market.saveTask(student, published.id, {}, key());
    assert.equal((await market.savedTasks(student))[0].due_date, input.dueDate);
    const application = await market.apply(
      student,
      published.id,
      { proposal: "I will deliver these milestones." },
      key(),
    );
    await market.inviteApplicant(owner, application.id, {}, key());
    const agreement = await market.acceptInvitation(
      student,
      application.id,
      {},
      key(),
    );
    const view = await market.agreement(owner, agreement.id);
    assert.equal(view.terms.dueDate, input.dueDate);
    assert.deepEqual(
      view.terms.milestones.map((m) => m.acceptance_criteria),
      detail.milestones.map((m) => m.acceptance_criteria),
    );
    assert.deepEqual(
      view.milestones.map((m) => m.acceptance_criteria),
      detail.milestones.map((m) => m.acceptance_criteria),
    );
    await assert.rejects(
      market.agreement(stranger, agreement.id),
      (error) => error.code === "not_found",
    );
    assert.equal((await market.agreements(stranger)).length, 0);
    await assert.rejects(
      f.owner.query(
        "UPDATE campus.milestones SET acceptance_criteria='Changed after acceptance' WHERE id=$1",
        [view.milestones[0].id],
      ),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      f.owner.query(
        "UPDATE campus.agreements SET terms=jsonb_set(terms,'{dueDate}','\"2029-01-01\"'::jsonb) WHERE id=$1",
        [agreement.id],
      ),
      (error) => error.code === "23514",
    );
    // Operator-only fixture changes prove that the signed copy does not follow
    // mutable source rows. No task editing endpoint is introduced here.
    await f.owner.query(
      "UPDATE campus.tasks SET due_date='2029-01-01' WHERE id=$1",
      [published.id],
    );
    await f.owner.query(
      "UPDATE campus.task_milestones SET acceptance_criteria='Changed listing' WHERE task_id=$1",
      [published.id],
    );
    assert.equal(
      (await market.agreement(student, agreement.id)).terms.dueDate,
      input.dueDate,
    );
    assert.deepEqual(
      (await market.agreement(student, agreement.id)).milestones.map(
        (m) => m.acceptance_criteria,
      ),
      detail.milestones.map((m) => m.acceptance_criteria),
    );
  } finally {
    await store.close();
    await f.close();
  }
});

test("omitted and null terms remain unspecified; a past target date is not an application cutoff", async () => {
  const f = await fixture(),
    store = createStore(f.urls),
    market = createMarket(store);
  try {
    const owner = await f.user("Publisher"),
      student = await f.user("Applicant");
    for (const input of [
      body,
      {
        ...body,
        dueDate: null,
        milestones: body.milestones.map((m) => ({
          ...m,
          acceptanceCriteria: null,
        })),
      },
    ]) {
      const task = await market.publishTask(owner, input, key());
      assert.equal(task.due_date, null);
      assert.deepEqual(
        (await market.task(student, task.id)).milestones.map(
          (m) => m.acceptance_criteria,
        ),
        [null, null],
      );
    }
    const past = await market.publishTask(
      owner,
      { ...body, dueDate: "2000-01-01" },
      key(),
    );
    const app = await market.apply(
      student,
      past.id,
      { proposal: "Discuss the historical target date." },
      key(),
    );
    await market.inviteApplicant(owner, app.id, {}, key());
    const agreement = await market.acceptInvitation(student, app.id, {}, key());
    assert.equal(agreement.state, "awaiting_funding");
    assert.equal(agreement.terms.dueDate, "2000-01-01");
    assert.deepEqual(
      agreement.terms.milestones.map((m) => m.acceptance_criteria),
      [null, null],
    );
  } finally {
    await store.close();
    await f.close();
  }
});

test("forward migration preserves old rows, signed JSON and publish idempotency receipts", async () => {
  const config = localConfig(),
    database = "campus_terms_upgrade_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(config, "migrator"),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const owner = new pg.Client({
    connectionString: connectionString(config, "migrator", database),
  });
  let store;
  try {
    await owner.connect();
    await owner.query(
      "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of [
      "001_foundation.sql",
      "002_workflow_guards.sql",
      "003_participant_labels.sql",
    ]) {
      const sql = await readFile(
        new URL(`../../backend/db/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await owner.query(sql);
      await owner.query(
        "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    const publisher = key(),
      student = key(),
      institution = key();
    await owner.query(
      "INSERT INTO campus.users(id,display_name) VALUES($1,'Publisher'),($2,'Student')",
      [publisher, student],
    );
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'Test University',true,'Synthetic migration test')",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('campus.example.test',$1,true)",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.affiliations SELECT id,$1,'campus.example.test',now()+interval '1 year',true FROM campus.users",
      [institution],
    );
    const oldTask = (
      await owner.query(
        "INSERT INTO campus.tasks(owner_id,title,category,description,reward_cents) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [
          publisher,
          body.title,
          body.category,
          body.description,
          body.rewardCents,
        ],
      )
    ).rows[0];
    await owner.query(
      "INSERT INTO campus.task_milestones(task_id,position,title,amount_cents,deliverable) VALUES($1,1,'Existing deliverable',10000,'Do not rewrite this')",
      [oldTask.id],
    );
    const app = (
      await owner.query(
        "INSERT INTO campus.applications(task_id,applicant_id,proposal,state) VALUES($1,$2,'Existing proposal','accepted') RETURNING id",
        [oldTask.id, student],
      )
    ).rows[0];
    const oldTerms = {
      taskTitle: body.title,
      description: body.description,
      rewardCents: body.rewardCents,
      milestones: [
        {
          position: 1,
          title: "Existing deliverable",
          amount_cents: 10000,
          deliverable: "Do not rewrite this",
        },
      ],
    };
    const agreement = (
      await owner.query(
        "INSERT INTO campus.agreements(task_id,application_id,owner_id,captain_id,terms) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [oldTask.id, app.id, publisher, student, JSON.stringify(oldTerms)],
      )
    ).rows[0];
    await owner.query(
      "INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable) VALUES($1,1,'Existing deliverable',10000,'Do not rewrite this')",
      [agreement.id],
    );
    const urls = Object.fromEntries(
      ["app", "auth", "worker"].map((role) => [
        role,
        connectionString(config, role, database),
      ]),
    );
    store = createStore(urls);
    const requestKey = key();
    const oldReceipt = await store.as(publisher, (c) =>
      idempotent(
        c,
        publisher,
        "task.publish",
        requestKey,
        body,
        async () => oldTask,
      ),
    );
    const migrationFiles = (
      await readdir(new URL("../../backend/db/migrations/", import.meta.url))
    ).filter((name) => /^\d+.*\.sql$/.test(name));
    const appliedBefore = Number(
      (await owner.query("SELECT count(*) FROM campus.schema_migrations"))
        .rows[0].count,
    );
    assert.equal(await migrate(owner), migrationFiles.length - appliedBefore);
    assert.equal(await migrate(owner), 0);
    assert.equal(
      (
        await owner.query("SELECT due_date FROM campus.tasks WHERE id=$1", [
          oldTask.id,
        ])
      ).rows[0].due_date,
      null,
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT deliverable,acceptance_criteria FROM campus.task_milestones WHERE task_id=$1",
          [oldTask.id],
        )
      ).rows[0],
      { deliverable: "Do not rewrite this", acceptance_criteria: null },
    );
    assert.equal(
      (
        await owner.query(
          "SELECT acceptance_criteria FROM campus.milestones WHERE agreement_id=$1",
          [agreement.id],
        )
      ).rows[0].acceptance_criteria,
      null,
    );
    assert.deepEqual(
      (
        await owner.query("SELECT terms FROM campus.agreements WHERE id=$1", [
          agreement.id,
        ])
      ).rows[0].terms,
      oldTerms,
    );
    assert.deepEqual(
      await createMarket(store).publishTask(publisher, body, requestKey),
      oldReceipt,
    );
  } finally {
    await store?.close();
    await owner.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
