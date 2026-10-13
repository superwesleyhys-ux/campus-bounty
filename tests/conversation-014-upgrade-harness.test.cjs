const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { randomUUID: key, createHash } = require("node:crypto");
const pg = require("pg");
const {
  createFixtureCleanup,
  cleanupSetupFailure,
} = require("./conversation-fixture-cleanup.cjs");
const {
  upgradeReviewed014,
  verifyReviewedReplay,
  reviewedPrior,
  migrationName,
  migrationSha,
} = require("./conversation-014-upgrade-harness.cjs");
const root = path.resolve(__dirname, "..");
const output = path.join(
  root,
  "docs/evidence/interaction-round10/upgrade-014-harness",
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
  const resources = { database, adminUrl, created: false };
  const close = createFixtureCleanup(resources);
  try {
    const admin = (resources.admin = new pg.Client({
      connectionString: adminUrl,
    }));
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    resources.created = true;
    const url = connectionString(config, "migrator", database);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const client = (resources.client = new pg.Client({
      connectionString: url,
    }));
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
      "INSERT INTO campus.institutions VALUES($1,'014 preservation university',true,'Synthetic')",
      [institution],
    );
    await client.query(
      "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('upgrade.example.test',$1,true)",
      [institution],
    );
    for (const id of [owner, captain]) {
      await client.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,'014 preservation account')",
        [id],
      );
      await client.query(
        "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'upgrade.example.test',now()+interval '1 year',true)",
        [id, institution],
      );
    }
    const store = (resources.store = createStore(
      Object.fromEntries(
        ["app", "auth", "worker"].map((role) => [
          role,
          connectionString(config, role, database),
        ]),
      ),
    ));
    const market = createMarket(store);
    const task = await market.publishTask(
      owner,
      {
        title: "Existing 013 collaboration",
        category: "Research",
        description: "Preserve signed data",
        rewardCents: 100,
        milestones: [
          {
            title: "Existing stage",
            amountCents: 100,
            deliverable: "Evidence",
          },
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
    const milestone = (await market.agreement(owner, agreement.id))
      .milestones[0];
    await market.submitMilestone(
      captain,
      milestone.id,
      {
        content: "Existing 013 submitted work",
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
      "013 exact work context really exists before 014",
    );
    const oldDefinition = await functionDefinition(client);
    const oldFields = (
      await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='campus' ORDER BY table_name,ordinal_position`)
    ).rows;
    const dataState = async () => {
      const result = {};
      for (const table of new Set(oldFields.map((x) => x.table_name))) {
        const projection = oldFields
          .filter((x) => x.table_name === table)
          .map((x) => '"' + x.column_name.replaceAll('"', '""') + '"')
          .join(",");
        result[table] = (
          await client.query(
            `SELECT row_to_json(t)::text AS row FROM (SELECT ${projection} FROM campus."${table}") t ORDER BY row_to_json(t)::text COLLATE "C"`,
          )
        ).rows;
      }
      return result;
    };
    const originalData = await dataState();
    return {
      client,
      config,
      database,
      oldDefinition,
      contextCount,
      dataState,
      originalData,
      close,
    };
  } catch (error) {
    await cleanupSetupFailure(error, close);
  }
}
async function unchanged(f) {
  assert.deepEqual(
    await f.dataState(),
    f.originalData,
    "Every original projected row survives rollback",
  );
  assert.equal(await functionDefinition(f.client), f.oldDefinition);
  assert.equal(
    (
      await f.client.query(
        "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='campus' AND table_name='messages' AND column_name='application_id'",
      )
    ).rows[0].n,
    0,
  );
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
test("014 preserves every existing table, real 013 context and receipts; replay is read-only", async () => {
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
    const result = await upgradeReviewed014(client, options);
    assert.equal(verifiedLocks, true);
    assert.equal(result.transactionOutcome, "committed");
    assert.equal(result.applied, 1);
    assert.equal(result.preservationVerifiedBeforeCommit, true);
    assert.deepEqual(result.before, result.after);
    assert.equal(result.exactContexts, f.contextCount);
    assert.ok(result.before.notification_work_context.count > 0);
    assert.equal(result.before.schema_migrations.count, 13);
    assert.equal(result.tables.length, 36);
    assert.notEqual(await functionDefinition(f.client), f.oldDefinition);
    assert.equal(result.historicalApplicationIdsNull, true);
    assert.deepEqual(result.applicationColumn, {
      name: "application_id",
      position: 7,
      type: "uuid",
      not_null: false,
      identity: "",
      generated: "",
      collation: "0",
      default_expression: null,
    });
    assert.equal(
      result.applicationForeignKeys[0].definition,
      "FOREIGN KEY (application_id) REFERENCES campus.applications(id)",
    );
    assert.ok(result.before.messages.count > 0);
    assert.ok(result.before.idempotency.count > 0);
    assert.ok(result.before.notifications.count > 0);
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
for (const kind of [
  "old-row",
  "old-column",
  "added-column",
  "added-fk",
  "old-application-id",
  "new-table",
])
  test(`014 rolls back injected ${kind} damage, replaced function and receipt before COMMIT`, async () => {
    const f = await baseline();
    try {
      const client = {
        connectionParameters: f.client.connectionParameters,
        query: async (...args) => {
          const result = await f.client.query(...args);
          if (isRepair(args[0]))
            await f.client.query(
              {
                "old-row":
                  "UPDATE campus.users SET display_name='Injected corruption'",
                "old-column":
                  "ALTER TABLE campus.users ALTER COLUMN display_name SET DEFAULT 'Injected definition'",
                "added-column":
                  "ALTER TABLE campus.messages ALTER COLUMN application_id SET DEFAULT gen_random_uuid()",
                "added-fk":
                  "ALTER TABLE campus.messages DROP CONSTRAINT messages_application_id_fkey",
                "old-application-id":
                  "ALTER TABLE campus.messages DROP CONSTRAINT messages_exactly_one_scope; UPDATE campus.messages SET application_id=(SELECT id FROM campus.applications LIMIT 1)",
                "new-table": "CREATE TABLE campus.unreviewed_table(id uuid)",
              }[kind],
            );
          return result;
        },
      };
      await assert.rejects(
        upgradeReviewed014(client, opts(`rollback-${kind}`)),
        (e) => {
          assert.equal(e.upgradeOutcome.transactionOutcome, "rolled_back");
          assert.equal(e.upgradeOutcome.phase, "validate_before_commit");
          return /Every old (row|column)|reviewed application foreign key|historical application message|reviewed target table/.test(
            e.message,
          );
        },
      );
      await unchanged(f);
    } finally {
      await f.close();
    }
  });
test("014 rejects wrong target/hash, unsafe connections and tampered 012 receipt", async () => {
  const f = await baseline();
  try {
    for (const [label, changes] of [
      ["wrong-hash", { expectedHash: "0".repeat(64) }],
      ["wrong-target", { migration: "012_conversation_history_context.sql" }],
    ]) {
      await assert.rejects(
        upgradeReviewed014(f.client, { ...opts(label), ...changes }),
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
        upgradeReviewed014(client, opts(label)),
        (e) => e.upgradeOutcome.transactionOutcome === "not_started",
      );
      assert.equal(queried, false);
    }
    await f.client.query(
      "UPDATE campus.schema_migrations SET checksum='tampered' WHERE name='012_conversation_history_context.sql'",
    );
    f.originalData = await f.dataState();
    await assert.rejects(
      upgradeReviewed014(f.client, opts("wrong-prior-receipt")),
      (e) => e.upgradeOutcome.transactionOutcome === "rolled_back",
    );
    await unchanged(f);
  } finally {
    await f.close();
  }
});
test("014 reports ambiguous COMMIT acknowledgment as unknown rather than claiming rollback", async () => {
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
      upgradeReviewed014(client, opts("commit-ack-unknown")),
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
test("014 reports failed rollback acknowledgment as unknown", async () => {
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
      upgradeReviewed014(client, opts("rollback-unknown")),
      (e) =>
        e.upgradeOutcome.transactionOutcome === "unknown" &&
        e.upgradeOutcome.applied === null,
    );
    await unchanged(f);
  } finally {
    await f.close();
  }
});
test.after(() => console.log(`014 disposable evidence: ${output}`));

test("014 rejects unknown files and byte mismatches in an isolated inventory copy without querying the DB", async () => {
  for (const kind of ["unknown-file", "old-checksum", "target-checksum"]) {
    const isolated = path.join(output, `inventory-${kind}`);
    fs.mkdirSync(path.join(isolated, "tests"), { recursive: true });
    fs.cpSync(
      path.join(root, "backend/db/migrations"),
      path.join(isolated, "backend/db/migrations"),
      { recursive: true },
    );
    fs.copyFileSync(
      path.join(root, "tests/conversation-reviewed-upgrade.cjs"),
      path.join(isolated, "tests/conversation-reviewed-upgrade.cjs"),
    );
    const name =
      kind === "unknown-file"
        ? "015_unreviewed.sql"
        : kind === "old-checksum"
          ? reviewedPrior[0].name
          : migrationName;
    fs.appendFileSync(
      path.join(isolated, "backend/db/migrations", name),
      "\n-- Isolated fixture mutation\n",
    );
    const engine = require(
      path.join(isolated, "tests/conversation-reviewed-upgrade.cjs"),
    );
    let queried = false;
    await assert.rejects(
      engine.upgradeReviewed014(
        {
          query: () => {
            queried = true;
            throw Error("Unexpected database access");
          },
        },
        opts(`inventory-reject-${kind}`),
      ),
      (e) =>
        e.upgradeOutcome.transactionOutcome === "not_started" &&
        /inventory|Reviewed migration changed/.test(e.message),
    );
    assert.equal(queried, false);
  }
});

test("014 rejects runtime roles before transaction and incompatible existing message schema before target SQL", async () => {
  const f = await baseline();
  try {
    const { connectionString } = await import("../scripts/backend-local.mjs");
    for (const role of ["app", "auth", "worker"]) {
      const client = new pg.Client({
        connectionString: connectionString(f.config, role, f.database),
      });
      await client.connect();
      try {
        await assert.rejects(
          upgradeReviewed014(client, opts(`runtime-role-${role}`)),
          (e) =>
            e.upgradeOutcome.transactionOutcome === "not_started" &&
            /migrator role/.test(e.message),
        );
      } finally {
        await client.end();
      }
    }
    await unchanged(f);
    await f.client.query(
      "ALTER TABLE campus.messages ADD COLUMN unreviewed text",
    );
    await assert.rejects(
      upgradeReviewed014(f.client, opts("schema-boundary")),
      (e) =>
        e.upgradeOutcome.transactionOutcome === "rolled_back" &&
        /six-column historical/.test(e.message),
    );
    await unchanged(f);
    assert.equal(
      (
        await f.client.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='campus' AND table_name='messages' AND column_name='unreviewed'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});
