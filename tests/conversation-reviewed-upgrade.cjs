// Single-reviewed-migration fixture harness. This deliberately never calls migrate(),
// whose internal COMMIT would escape the pre-commit preservation checks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const migration012Name = "012_conversation_history_context.sql";
const migration012Sha =
  "05ce34dd5067ae44bf6e1f15cc995f8184ddbe6e352228c554fb919bdf837d26";
const prior011 = Object.entries({
  "001_foundation.sql":
    "ad3759fcff58538fedbf074b6b1d7da5e48581047675b0a320664d51f532514b",
  "002_workflow_guards.sql":
    "3bdd3b50670af1fd2b4e7cad6f8fed9e1851ecab723275039e2140c1d4195a5f",
  "003_participant_labels.sql":
    "f8d83263a613ba7de8ca14509faa9dff67682df3fe79570a156b44729896d9ea",
  "004_task_terms.sql":
    "3fc5eb151c543136c460437a9e4e5434db3f657c1c92a8f1d619d0c21d19ca20",
  "005_application_lifecycle.sql":
    "55b3e00d6e1a132f443d0cf3c76399f4920a77f5a99e249e653b5ca81540a89f",
  "006_order_cancellation.sql":
    "e795105c3723102bc129b2fdb786a01867d9fc21b4864e31e5f60a7573d0ca54",
  "007_account_eligibility.sql":
    "09bd68979454690c716a48088f2a8d438cf209037c321857eb04947289e55f6c",
  "008_team_lifecycle.sql":
    "413719c439b710332db1d77903e31b3d0cd64f255c12188cd4136009087edec6",
  "009_team_context.sql":
    "88dc7aaf4e28b02636b1a0bb65f55a14eddfe42211beb4e7d5f77316483870f0",
  "010_milestone_revision_workflow.sql":
    "14266b68faaae8db3104872ceaffd78f8cfb92b45b6e3a1a3b550af250ad27f1",
  "011_notifications_and_overview.sql":
    "3a08d04d84ba90fb636b574591e3720c92fa60aba13bee99ac976a0a79075011",
}).map(([name, checksum]) => ({ name, checksum }));
const migration013Name = "013_message_scope_revalidation.sql";
const migration013Sha =
  "ed5d08606e7dd93d588cba87993dbd5f7f9c556649da7f9e60b39d1414405190";
const prior012 = [
  ...prior011,
  { name: migration012Name, checksum: migration012Sha },
];
const migration014Name = "014_application_conversations.sql";
const migration014Sha =
  "57c0cb2114f2941374660309dd94afef8ebac946dc14c807cccfc99756f0459c";
const prior013 = [
  ...prior012,
  { name: migration013Name, checksum: migration013Sha },
];
// Exact reviewed presets only. No discovered filename becomes an approved target.
const presets = {
  "012": {
    migrationName: migration012Name,
    migrationSha: migration012Sha,
    reviewedPrior: prior011,
    newTables: [{ name: "notification_work_context", kind: "r" }],
  },
  "014": {
    migrationName: migration014Name,
    migrationSha: migration014Sha,
    reviewedPrior: prior013,
    newTables: [],
  },
  "013": {
    migrationName: migration013Name,
    migrationSha: migration013Sha,
    reviewedPrior: prior012,
    newTables: [],
  },
};
const reviewedInventory = [
  ...prior013,
  { name: migration014Name, checksum: migration014Sha },
];
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
freeze(presets);
freeze(reviewedInventory);
const migrationsDir = path.resolve(__dirname, "../backend/db/migrations");
function reviewedSql(expected, name, preset) {
  const { migrationName, migrationSha } = preset;
  assert.equal(
    name,
    migrationName,
    "Only the explicitly reviewed target may be applied",
  );
  assert.equal(
    expected,
    migrationSha,
    "Expected hash must match the reviewed frozen target",
  );
  const expectedRows = reviewedInventory;
  assert.deepEqual(
    fs
      .readdirSync(migrationsDir)
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort(),
    expectedRows.map((r) => r.name),
    "Migration directory must have exactly the reviewed 001–014 inventory",
  );
  let sql;
  for (const row of expectedRows) {
    const bytes = fs.readFileSync(path.join(migrationsDir, row.name));
    assert.equal(
      digest(bytes),
      row.checksum,
      `Reviewed migration changed: ${row.name}`,
    );
    if (row.name === migrationName) sql = bytes.toString("utf8");
  }
  return sql;
}
async function guard(client) {
  assert.equal(
    client.connectionParameters.host,
    "127.0.0.1",
    "Fixture connection must use loopback",
  );
  assert.match(
    client.connectionParameters.database,
    /^campus_test_[a-f0-9]{32}$/,
  );
  const { database, role, session_role } = (
    await client.query(
      "SELECT current_database() AS database,current_user AS role,session_user AS session_role",
    )
  ).rows[0];
  assert.equal(
    role,
    "campus_migrator",
    "Only the fixture migrator role may upgrade",
  );
  assert.equal(
    session_role,
    "campus_migrator",
    "Do not upgrade through role impersonation",
  );
  assert.equal(
    database,
    client.connectionParameters.database,
    "Connected fixture identity must match",
  );
}
const tableCatalog = async (client) =>
  (
    await client.query(
      "SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='campus' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE \"C\"",
    )
  ).rows;
async function columnCatalog(client, tables) {
  const result = {};
  for (const { name } of tables)
    result[name] = (
      await client.query(
        `SELECT a.attname AS name,a.attnum AS position,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
 a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,a.attcollation::text AS collation,
 pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE n.nspname='campus' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [name],
      )
    ).rows;
  return result;
}
async function snapshot(client, columns, migrationName = null) {
  const values = {};
  for (const [table, fields] of Object.entries(columns)) {
    const where =
      table === "schema_migrations" && migrationName ? " WHERE name <> $1" : "";
    const projection = fields.map((c) => quote(c.name)).join(",");
    const rows = (
      await client.query(
        `SELECT row_to_json(t)::text AS row FROM (SELECT ${projection} FROM campus.${quote(table)}${where}) t ORDER BY row_to_json(t)::text COLLATE "C"`,
        where ? [migrationName] : [],
      )
    ).rows;
    values[table] = {
      count: rows.length,
      sha256: digest(JSON.stringify(rows)),
    };
  }
  return values;
}
async function priorRows(client, migrationName = null) {
  return (
    await client.query(
      `SELECT name,checksum FROM campus.schema_migrations${migrationName ? " WHERE name <> $1" : ""} ORDER BY name`,
      migrationName ? [migrationName] : [],
    )
  ).rows;
}
function writeEvidence(directory, name, value) {
  fs.writeFileSync(
    path.join(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { flag: "wx" },
  );
}
async function upgradeReviewed(
  client,
  { expectedHash, migration, evidenceDirectory },
  preset,
) {
  const { migrationName, reviewedPrior } = preset;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const evidence = {
    migration,
    sha256: expectedHash,
    transactionOutcome: "not_started",
    phase: "preflight",
    applied: 0,
  };
  const output = path.join(evidenceDirectory, "transaction-outcome.json");
  assert.ok(!fs.existsSync(output), "Do not overwrite an earlier attempt");
  let transactionOpen = false,
    commitStarted = false;
  try {
    const sql = reviewedSql(expectedHash, migration, preset);
    // Preserve the exact checked bytes before opening a transaction. The SQL
    // string below is this captured value, never a later mutable file read.
    fs.writeFileSync(path.join(evidenceDirectory, "reviewed.sql"), sql, {
      flag: "wx",
    });
    writeEvidence(
      evidenceDirectory,
      "reviewed-inventory.json",
      reviewedInventory,
    );
    await guard(client);
    await client.query("BEGIN");
    transactionOpen = true;
    evidence.transactionOutcome = "pending";
    await client.query(
      "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'; SET LOCAL idle_in_transaction_session_timeout='30s'",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('campus.migrations'))",
    );
    evidence.phase = "locking_old_tables";
    const tables = await tableCatalog(client);
    assert.ok(tables.some((t) => t.name === "schema_migrations"));
    // Deterministic catalog-derived order; SHARE ROW EXCLUSIVE prevents all ordinary
    // INSERT/UPDATE/DELETE/TRUNCATE and other migration DDL until COMMIT/ROLLBACK.
    for (const table of tables)
      await client.query(
        `LOCK TABLE campus.${quote(table.name)} IN SHARE ROW EXCLUSIVE MODE`,
      );
    assert.deepEqual(
      await tableCatalog(client),
      tables,
      "Old table inventory changed while locking",
    );
    assert.deepEqual(
      await priorRows(client),
      reviewedPrior,
      "Requires exact reviewed prior database receipts",
    );
    const columns = await columnCatalog(client, tables),
      before = await snapshot(client, columns);
    if (preset === presets["014"])
      assert.deepEqual(
        columns.messages.map((c) => c.name),
        ["id", "sender_id", "agreement_id", "order_id", "body", "created_at"],
        "014 requires the reviewed six-column historical messages schema",
      );
    evidence.phase = "before_sql";
    evidence.tables = tables;
    evidence.comparedColumns = columns;
    evidence.before = before;
    writeEvidence(evidenceDirectory, "before.json", {
      phase: evidence.phase,
      migration,
      sha256: expectedHash,
      priorMigrations: reviewedPrior,
      tables,
      comparedColumns: columns,
      before,
    });
    evidence.phase = "execute_reviewed_sql";
    await client.query(sql);
    await client.query(
      "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
      [migration, expectedHash],
    );
    evidence.phase = "validate_before_commit";
    const after = await snapshot(client, columns, migrationName);
    const afterColumns = await columnCatalog(client, tables);
    assert.deepEqual(
      await tableCatalog(client),
      [...tables, ...preset.newTables].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
      "Only the reviewed target table additions may occur",
    );
    const expectedColumns =
      preset === presets["014"]
        ? {
            ...columns,
            messages: [
              ...columns.messages,
              {
                name: "application_id",
                position: 7,
                type: "uuid",
                not_null: false,
                identity: "",
                generated: "",
                collation: "0",
                default_expression: null,
              },
            ],
          }
        : columns;
    assert.deepEqual(
      afterColumns,
      expectedColumns,
      "Every old column definition must remain unchanged",
    );
    assert.deepEqual(
      after,
      before,
      "Every old row/column must survive unchanged, including saved/idempotency/audit/events and old migration receipts",
    );
    assert.deepEqual(
      await priorRows(client, migrationName),
      reviewedPrior,
      "Old migration receipts must remain unchanged",
    );
    assert.deepEqual(await priorRows(client), [
      ...reviewedPrior,
      { name: migration, checksum: expectedHash },
    ]);
    if (preset === presets["014"]) {
      const foreignKeys = (
        await client.query(`SELECT c.conname AS name,
        pg_get_constraintdef(c.oid) AS definition,c.convalidated AS validated,
        c.condeferrable AS deferrable,c.condeferred AS deferred
        FROM pg_constraint c WHERE c.conrelid='campus.messages'::regclass
        AND c.contype='f' AND 7=ANY(c.conkey) ORDER BY c.conname`)
      ).rows;
      assert.deepEqual(
        foreignKeys,
        [
          {
            name: "messages_application_id_fkey",
            definition:
              "FOREIGN KEY (application_id) REFERENCES campus.applications(id)",
            validated: true,
            deferrable: false,
            deferred: false,
          },
        ],
        "Only the reviewed application foreign key is allowed",
      );
      const populated = (
        await client.query(
          "SELECT count(*)::int AS n FROM campus.messages WHERE application_id IS NOT NULL",
        )
      ).rows[0].n;
      assert.equal(
        populated,
        0,
        "No historical application message may be invented",
      );
      evidence.applicationColumn = afterColumns.messages.at(-1);
      evidence.applicationForeignKeys = foreignKeys;
      evidence.historicalApplicationIdsNull = true;
    }
    const exactContexts = (
      await client.query(
        "SELECT count(*)::int AS n FROM campus.notification_work_context",
      )
    ).rows[0].n;
    if (preset === presets["012"])
      assert.equal(exactContexts, 0, "No historical context may be invented");
    // 013 preserves existing real context rows via the same old-column hashes.
    // It must not require zero, delete, recreate or backfill them.
    reviewedSql(expectedHash, migration, preset); // Verify files again while rollback is still possible.
    evidence.preservationVerifiedBeforeCommit = true;
    evidence.after = after;
    evidence.exactContexts = exactContexts;
    evidence.preservedNotifications = after.notifications.count;
    writeEvidence(evidenceDirectory, "validated-before-commit.json", {
      phase: "validated_pending_commit",
      migration,
      sha256: expectedHash,
      after,
      exactContexts,
      comparedColumns: afterColumns,
      applicationColumn: evidence.applicationColumn,
      applicationForeignKeys: evidence.applicationForeignKeys,
      historicalApplicationIdsNull: evidence.historicalApplicationIdsNull,
    });
    evidence.phase = "commit";
    commitStarted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    evidence.transactionOutcome = "committed";
    evidence.applied = 1;
    evidence.phase = "committed";
    writeEvidence(evidenceDirectory, "transaction-outcome.json", evidence);
    return evidence;
  } catch (error) {
    evidence.failure = {
      name: error.name,
      code: error.code || null,
      message: error.message,
    };
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        evidence.rollbackCommand = "succeeded";
        evidence.transactionOutcome = commitStarted
          ? "commit_outcome_unknown"
          : "rolled_back";
      } catch (rollbackError) {
        evidence.rollbackCommand = "failed";
        evidence.rollbackError = {
          code: rollbackError.code || null,
          message: rollbackError.message,
        };
        evidence.transactionOutcome = "unknown";
      }
    }
    // Never turn an ambiguous COMMIT/network failure into a false rollback claim.
    if (
      ["unknown", "commit_outcome_unknown"].includes(
        evidence.transactionOutcome,
      )
    )
      evidence.applied = null;
    if (!fs.existsSync(output))
      writeEvidence(evidenceDirectory, "transaction-outcome.json", evidence);
    error.upgradeOutcome = evidence;
    throw error;
  }
}
async function verifyReviewedReplay(
  client,
  { expectedHash, migration },
  preset,
) {
  const { migrationName, migrationSha, reviewedPrior } = preset;
  reviewedSql(expectedHash, migration, preset);
  await guard(client);
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(
      "SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'",
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('campus.migrations'))",
    );
    assert.deepEqual(await priorRows(client), [
      ...reviewedPrior,
      { name: migrationName, checksum: migrationSha },
    ]);
    // Same exact reviewed inventory, all receipts present: no SQL is pending.
    await client.query("COMMIT");
    return 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
// Keep selection internal: callers choose a named reviewed helper, never a SQL path.
module.exports = {
  upgradeReviewed012: (client, options) =>
    upgradeReviewed(client, options, presets["012"]),
  upgradeReviewed013: (client, options) =>
    upgradeReviewed(client, options, presets["013"]),
  verifyReviewedReplay012: (client, options) =>
    verifyReviewedReplay(client, options, presets["012"]),
  verifyReviewedReplay013: (client, options) =>
    verifyReviewedReplay(client, options, presets["013"]),
  upgradeReviewed014: (client, options) =>
    upgradeReviewed(client, options, presets["014"]),
  verifyReviewedReplay014: (client, options) =>
    verifyReviewedReplay(client, options, presets["014"]),
  prior013,
  migration014Name,
  migration014Sha,
  prior011,
  prior012,
  migration012Name,
  migration012Sha,
  migration013Name,
  migration013Sha,
};
