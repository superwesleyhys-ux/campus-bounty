const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { randomUUID: key, createHash } = require("node:crypto");
const pg = require("pg");
const {
  upgradeReviewed013,
  verifyReviewedReplay,
  reviewedPrior,
  migrationName,
  migrationSha,
} = require("./conversation-013-upgrade-harness.cjs");
const root = path.resolve(__dirname, "..");
const output = path.join(
  root,
  "docs/evidence/interaction-round8/upgrade-013-harness",
  `disposable-${new Date().toISOString().replaceAll(":", "-")}-${key()}`,
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const opts = (label) => ({
  expectedHash: migrationSha,
  migration: migrationName,
  evidenceDirectory: path.join(output, label),
});
const functionDefinition = async (c) =>
  (
    await c.query(
      "SELECT pg_get_functiondef('campus.authorize_message_scope(text,uuid)'::regprocedure) AS definition",
    )
  ).rows[0].definition;
const isRepair = (sql) =>
  typeof sql === "string" &&
  sql.includes("CREATE OR REPLACE FUNCTION campus.authorize_message_scope");
async function baseline() {
  const { localConfig, connectionString } =
    await import("../scripts/backend-local.mjs");
  const { createStore } = await import("../backend/db/store.mjs");
  const { createMarket } = await import("../backend/modules/market.mjs");
  const config = localConfig(),
    database = "campus_test_" + key().replaceAll("-", "");
  assert.match(database, /^campus_test_[a-f0-9]{32}$/);
  const adminUrl = connectionString(config, "migrator");
  assert.equal(new URL(adminUrl).hostname, "127.0.0.1");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const url = connectionString(config, "migrator", database);
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    "CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const row of reviewedPrior) {
    const bytes = fs.readFileSync(
      path.join(root, "backend/db/migrations", row.name),
    );
    assert.equal(digest(bytes), row.checksum);
    await client.query(bytes.toString("utf8"));
    await client.query(
      "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
      [row.name, row.checksum],
    );
  }
  const institution = key(),
    owner = key(),
    captain = key();
  await client.query(
    "INSERT INTO campus.institutions VALUES($1,'013 preservation university',true,'Synthetic')",
    [institution],
  );
  await client.query(
    "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('upgrade.example.test',$1,true)",
    [institution],
  );
  for (const id of [owner, captain]) {
    await client.query(
      "INSERT INTO campus.users(id,display_name) VALUES($1,'013 preservation account')",
      [id],
    );
    await client.query(
      "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'upgrade.example.test',now()+interval '1 year',true)",
      [id, institution],
    );
  }
  const store = createStore(
    Object.fromEntries(
      ["app", "auth", "worker"].map((role) => [
        role,
        connectionString(config, role, database),
      ]),
    ),
  );
  const market = createMarket(store);
  const task = await market.publishTask(
    owner,
    {
      title: "Existing 012 collaboration",
      category: "Research",
      description: "Preserve signed data",
      rewardCents: 100,
      milestones: [
        { title: "Existing stage", amountCents: 100, deliverable: "Evidence" },
      ],
    },
    key(),
  );
  const application = await market.apply(
    captain,
    task.id,
    { proposal: "Existing proposal" },
    key(),
  );
  await market.inviteApplicant(owner, application.id, {}, key());
  const agreement = await market.acceptInvitation(
    captain,
    application.id,
    {},
    key(),
  );
  await market.sendMessage(
    captain,
    { agreementId: agreement.id, body: "Existing immutable 012 message" },
    key(),
  );
  await client.query(
    "UPDATE campus.agreements SET state='active' WHERE id=$1",
    [agreement.id],
  );
  const milestone = (await market.agreement(owner, agreement.id)).milestones[0];
  await market.submitMilestone(
    captain,
    milestone.id,
    {
      content: "Existing 012 submitted work",
      expectedVersion: milestone.version,
      expectedRevision: milestone.revision,
    },
    key(),
  );
  await client.query(
    "UPDATE campus.notifications SET read_at=created_at WHERE kind='milestone.submitted'",
  );
  await client.query(
    "INSERT INTO campus.saved(user_id,task_id) VALUES($1,$2)",
    [owner, task.id],
  );
  const contextCount = (
    await client.query(
      "SELECT count(*)::int n FROM campus.notification_work_context",
    )
  ).rows[0].n;
  assert.ok(
    contextCount > 0,
    "012 exact work context really exists before 013",
  );
  const oldDefinition = await functionDefinition(client);
  return {
    client,
    oldDefinition,
    contextCount,
    async close() {
      await store.close();
      await client.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
async function unchanged(f) {
  assert.equal(await functionDefinition(f.client), f.oldDefinition);
  assert.equal(
    (
      await f.client.query(
        "SELECT count(*)::int n FROM campus.schema_migrations WHERE name=$1",
        [migrationName],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.client.query(
        "SELECT count(*)::int n FROM campus.notification_work_context",
      )
    ).rows[0].n,
    f.contextCount,
  );
}
test("013 preserves every existing table, real 012 context and receipts; replay is read-only", async () => {
  const f = await baseline(),
    options = opts("success");
  try {
    let verifiedLocks = false;
    const client = {
      connectionParameters: f.client.connectionParameters,
      query: async (...args) => {
        if (isRepair(args[0])) {
          const locks = (
            await f.client.query(
              "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND n.nspname='campus' AND c.relkind IN ('r','p') AND l.mode='ShareRowExclusiveLock' AND l.granted ORDER BY c.relname",
            )
          ).rows;
          const tables = (
            await f.client.query(
              "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='campus' AND c.relkind IN ('r','p') ORDER BY c.relname",
            )
          ).rows;
          assert.deepEqual(locks, tables);
          assert.equal(
            (
              await f.client.query(
                "SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            fs.readFileSync(
              path.join(options.evidenceDirectory, "reviewed.sql"),
              "utf8",
            ),
            args[0],
          );
          verifiedLocks = true;
        }
        return f.client.query(...args);
      },
    };
    const result = await upgradeReviewed013(client, options);
    assert.equal(verifiedLocks, true);
    assert.equal(result.transactionOutcome, "committed");
    assert.equal(result.applied, 1);
    assert.deepEqual(result.before, result.after);
    assert.equal(result.exactContexts, f.contextCount);
    assert.ok(result.before.notification_work_context.count > 0);
    assert.equal(result.before.schema_migrations.count, 12);
    assert.equal(result.tables.length, 36);
    assert.notEqual(await functionDefinition(f.client), f.oldDefinition);
    const commands = [];
    assert.equal(
      await verifyReviewedReplay(
        {
          connectionParameters: f.client.connectionParameters,
          query: (...args) => {
            commands.push(args[0]);
            return f.client.query(...args);
          },
        },
        options,
      ),
      0,
    );
    assert.ok(commands.includes("BEGIN READ ONLY"));
    assert.ok(
      commands.every(
        (sql) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(sql),
      ),
    );
  } finally {
    await f.close();
  }
});
for (const kind of ["old-row", "old-column"])
  test(`013 rolls back injected ${kind} damage, replaced function and receipt before COMMIT`, async () => {
    const f = await baseline();
    try {
      const client = {
        connectionParameters: f.client.connectionParameters,
        query: async (...args) => {
          const result = await f.client.query(...args);
          if (isRepair(args[0]))
            await f.client.query(
              kind === "old-row"
                ? "UPDATE campus.users SET display_name='Injected corruption'"
                : "ALTER TABLE campus.users ALTER COLUMN display_name SET DEFAULT 'Injected definition'",
            );
          return result;
        },
      };
      await assert.rejects(
        upgradeReviewed013(client, opts(`rollback-${kind}`)),
        (e) => {
          assert.equal(e.upgradeOutcome.transactionOutcome, "rolled_back");
          assert.equal(e.upgradeOutcome.phase, "validate_before_commit");
          return /Every old (row|column)/.test(e.message);
        },
      );
      await unchanged(f);
    } finally {
      await f.close();
    }
  });
test("013 rejects wrong target/hash, unsafe connections and tampered 012 receipt", async () => {
  const f = await baseline();
  try {
    for (const [label, changes] of [
      ["wrong-hash", { expectedHash: "0".repeat(64) }],
      ["wrong-target", { migration: "012_conversation_history_context.sql" }],
    ]) {
      await assert.rejects(
        upgradeReviewed013(f.client, { ...opts(label), ...changes }),
        (e) => e.upgradeOutcome.transactionOutcome === "not_started",
      );
      await unchanged(f);
    }
    for (const [label, changes] of [
      ["wrong-host", { host: "localhost" }],
      ["wrong-database", { database: "campus_production" }],
    ]) {
      let queried = false;
      const client = {
        connectionParameters: { ...f.client.connectionParameters, ...changes },
        query: () => {
          queried = true;
          throw Error("Unexpected SQL");
        },
      };
      await assert.rejects(
        upgradeReviewed013(client, opts(label)),
        (e) => e.upgradeOutcome.transactionOutcome === "not_started",
      );
      assert.equal(queried, false);
    }
    await f.client.query(
      "UPDATE campus.schema_migrations SET checksum='tampered' WHERE name='012_conversation_history_context.sql'",
    );
    await assert.rejects(
      upgradeReviewed013(f.client, opts("wrong-prior-receipt")),
      (e) => e.upgradeOutcome.transactionOutcome === "rolled_back",
    );
    await unchanged(f);
  } finally {
    await f.close();
  }
});
test("013 reports ambiguous COMMIT acknowledgment as unknown rather than claiming rollback", async () => {
  const f = await baseline();
  try {
    const client = {
      connectionParameters: f.client.connectionParameters,
      query: async (...args) => {
        const result = await f.client.query(...args);
        if (args[0] === "COMMIT")
          throw Object.assign(
            new Error("Injected lost COMMIT acknowledgment"),
            { code: "ECONNRESET" },
          );
        return result;
      },
    };
    await assert.rejects(
      upgradeReviewed013(client, opts("commit-ack-unknown")),
      (e) =>
        e.upgradeOutcome.transactionOutcome === "commit_outcome_unknown" &&
        e.upgradeOutcome.applied === null,
    );
    // Independent readback knows the outcome; the helper did not have that proof.
    assert.equal(await verifyReviewedReplay(f.client, opts("readback")), 0);
  } finally {
    await f.close();
  }
});
test("013 reports failed rollback acknowledgment as unknown", async () => {
  const f = await baseline();
  try {
    const client = {
      connectionParameters: f.client.connectionParameters,
      query: async (...args) => {
        const result = await f.client.query(...args);
        if (isRepair(args[0])) throw new Error("Injected failure after SQL");
        if (args[0] === "ROLLBACK")
          throw new Error("Injected lost rollback acknowledgment");
        return result;
      },
    };
    await assert.rejects(
      upgradeReviewed013(client, opts("rollback-unknown")),
      (e) =>
        e.upgradeOutcome.transactionOutcome === "unknown" &&
        e.upgradeOutcome.applied === null,
    );
    await unchanged(f);
  } finally {
    await f.close();
  }
});
test.after(() => console.log(`013 disposable evidence: ${output}`));
