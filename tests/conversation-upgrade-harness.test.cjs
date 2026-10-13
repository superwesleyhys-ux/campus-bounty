const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const pg = require("pg");
const {
  upgradeReviewed012,
  verifyReviewedReplay,
  reviewedPrior,
  migrationName,
  migrationSha,
} = require("./conversation-upgrade-harness.cjs");
const root = path.resolve(__dirname, "..");
const runFolder = path.join(
  root,
  "docs/evidence/interaction-round8/upgrade-harness",
  `disposable-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
);
fs.mkdirSync(runFolder, { recursive: true });
async function baseline() {
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const config = localConfig(),
    database = "campus_test_" + randomUUID().replaceAll("-", "");
  const adminUrl = connectionString(config, "migrator");
  assert.equal(new URL(adminUrl).hostname, "127.0.0.1");
  assert.match(database, /^campus_test_[a-f0-9]{32}$/);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const url = connectionString(config, "migrator", database),
    client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const row of reviewedPrior) {
    await client.query(
      fs.readFileSync(
        path.join(root, "backend/db/migrations", row.name),
        "utf8",
      ),
    );
    await client.query(
      "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
      [row.name, row.checksum],
    );
  }
  const actor = randomUUID(),
    task = randomUUID();
  await client.query(
    "INSERT INTO campus.users(id,display_name) VALUES($1,'Synthetic old user')",
    [actor],
  );
  await client.query(
    "INSERT INTO campus.tasks(id,owner_id,title,category) VALUES($1,$2,'Synthetic old task','Research')",
    [task, actor],
  );
  await client.query(
    "INSERT INTO campus.saved(user_id,task_id) VALUES($1,$2)",
    [actor, task],
  );
  await client.query(
    "INSERT INTO campus.idempotency(actor_id,operation,key,request_hash,response) VALUES($1,'fixture','preserved-key','synthetic-hash','{\"id\":\"synthetic-receipt\"}')",
    [actor],
  );
  await client.query(
    "INSERT INTO campus.audit(actor_id,action,object_id) VALUES($1,'old-action',$2)",
    [actor, task],
  );
  await client.query(
    "INSERT INTO campus.events(kind,object_id) VALUES('old-event',$1)",
    [task],
  );
  await client.query(
    "INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id,read_at) VALUES($1,'old-notification','message.received','agreement',$2,'2026-01-01T00:00:00.123456Z')",
    [actor, task],
  );
  return {
    client,
    url,
    actor,
    task,
    async close() {
      await client.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
const options = (label) => ({
  expectedHash: migrationSha,
  migration: migrationName,
  evidenceDirectory: path.join(runFolder, label),
});
async function assertNotApplied(client) {
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int n FROM campus.schema_migrations WHERE name=$1",
        [migrationName],
      )
    ).rows[0].n,
    0,
  );
  const ddl = (
    await client.query(
      "SELECT to_regclass('campus.notification_work_context') AS context_table,to_regclass('campus.messages_agreement_history') AS history_index,to_regprocedure('campus.guard_message_send()') AS insert_gate",
    )
  ).rows[0];
  assert.deepEqual(ddl, {
    context_table: null,
    history_index: null,
    insert_gate: null,
  });
  assert.equal(
    (await client.query("SELECT kind FROM campus.events")).rows[0].kind,
    "old-event",
  );
}

test("injected post-SQL preservation failure rolls back reviewed012 DDL, old-data corruption and migration receipt", async () => {
  const f = await baseline(),
    opts = options("injected-failure");
  try {
    const client = {
      connectionParameters: f.client.connectionParameters,
      query: async (...args) => {
        const result = await f.client.query(...args);
        if (
          typeof args[0] === "string" &&
          args[0].includes("CREATE FUNCTION campus.conversation_people")
        )
          await f.client.query(
            "UPDATE campus.events SET kind='injected-after-sql' WHERE kind='old-event'",
          );
        return result;
      },
    };
    await assert.rejects(upgradeReviewed012(client, opts), (e) => {
      assert.equal(e.upgradeOutcome.transactionOutcome, "rolled_back");
      assert.equal(e.upgradeOutcome.phase, "validate_before_commit");
      return /Every old row/.test(e.message);
    });
    await assertNotApplied(f.client);
    const outcome = JSON.parse(
      fs.readFileSync(
        path.join(opts.evidenceDirectory, "transaction-outcome.json"),
      ),
    );
    assert.equal(outcome.transactionOutcome, "rolled_back");
    assert.equal(outcome.rollbackCommand, "succeeded");
    assert.equal(outcome.applied, 0);
    assert.ok(
      !fs.existsSync(
        path.join(opts.evidenceDirectory, "validated-before-commit.json"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("successful exact012 upgrade locks every old table against concurrent writes and preserves all old rows/columns", async () => {
  const f = await baseline(),
    writer = new pg.Client({ connectionString: f.url }),
    opts = options("success");
  await writer.connect();
  try {
    await writer.query("SET lock_timeout='100ms'");
    let intercepted = false;
    const client = {
      connectionParameters: f.client.connectionParameters,
      query: async (...args) => {
        if (
          typeof args[0] === "string" &&
          args[0].includes("CREATE FUNCTION campus.conversation_people")
        ) {
          intercepted = true;
          const locks = (
            await f.client.query(
              "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND n.nspname='campus' AND c.relkind IN ('r','p') AND l.mode='ShareRowExclusiveLock' AND l.granted ORDER BY c.relname",
            )
          ).rows.map((x) => x.relname);
          const tables = (
            await f.client.query(
              "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='campus' AND c.relkind IN ('r','p') ORDER BY c.relname",
            )
          ).rows.map((x) => x.relname);
          assert.deepEqual(locks, tables);
          await assert.rejects(
            writer.query(
              "INSERT INTO campus.events(kind,object_id) VALUES('concurrent-write',$1)",
              [f.task],
            ),
            (e) => e.code === "55P03",
          );
        }
        return f.client.query(...args);
      },
    };
    const outcome = await upgradeReviewed012(client, opts);
    assert.equal(intercepted, true);
    assert.equal(outcome.transactionOutcome, "committed");
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.exactContexts, 0);
    for (const name of [
      "saved",
      "idempotency",
      "audit",
      "events",
      "institutions",
      "domains",
      "identities",
      "sessions",
      "challenges",
      "rate_limits",
      "mail_jobs",
      "eligibility_reviewers",
      "schema_migrations",
    ])
      assert.ok(name in outcome.before, `${name} must be preserved`);
    for (const name of [
      "saved",
      "idempotency",
      "audit",
      "events",
      "notifications",
    ])
      assert.equal(outcome.before[name].count, 1);
    assert.deepEqual(outcome.before, outcome.after);
    assert.equal(await verifyReviewedReplay(f.client, opts), 0);
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int n FROM campus.schema_migrations",
        )
      ).rows[0].n,
      12,
    );
    assert.equal(
      (await f.client.query("SELECT kind FROM campus.events")).rows[0].kind,
      "old-event",
    );
    // Reads are unlocked only after commit; next normal writer can proceed.
    await writer.query(
      "INSERT INTO campus.events(kind,object_id) VALUES('post-commit-write',$1)",
      [f.task],
    );
    fs.writeFileSync(
      path.join(opts.evidenceDirectory, "proof-summary.json"),
      JSON.stringify(
        {
          committed: true,
          oldTableCount: outcome.tables.length,
          allOldTableLocksVerified: true,
          concurrentWriteBlocked: true,
          replayApplied: 0,
          noHistoricalContext: true,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } finally {
    await writer.end();
    await f.close();
  }
});

test("preexisting concurrent writer causes bounded lock timeout and rollback before migration SQL", async () => {
  const f = await baseline(),
    writer = new pg.Client({ connectionString: f.url }),
    opts = options("lock-timeout");
  await writer.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      "INSERT INTO campus.events(kind,object_id) VALUES('held-writer',$1)",
      [f.task],
    );
    const started = Date.now();
    await assert.rejects(
      upgradeReviewed012(f.client, opts),
      (e) =>
        e.code === "55P03" &&
        e.upgradeOutcome.transactionOutcome === "rolled_back" &&
        e.upgradeOutcome.phase === "locking_old_tables",
    );
    assert.ok(Date.now() - started < 7000, "Lock wait must be bounded");
    await writer.query("ROLLBACK");
    await assertNotApplied(f.client);
  } finally {
    await writer.query("ROLLBACK").catch(() => {});
    await writer.end();
    await f.close();
  }
});

test("unapproved checksum and modified old receipt fail closed without applying012", async () => {
  const f = await baseline();
  try {
    await assert.rejects(
      upgradeReviewed012(f.client, {
        ...options("wrong-hash"),
        expectedHash: "0".repeat(64),
      }),
      (e) => e.upgradeOutcome.transactionOutcome === "not_started",
    );
    await assertNotApplied(f.client);
    await f.client.query(
      "UPDATE campus.schema_migrations SET checksum='tampered' WHERE name=$1",
      [reviewedPrior[0].name],
    );
    await assert.rejects(
      upgradeReviewed012(f.client, options("wrong-prior-receipt")),
      (e) => e.upgradeOutcome.transactionOutcome === "rolled_back",
    );
    await assertNotApplied(f.client);
  } finally {
    await f.close();
  }
});
