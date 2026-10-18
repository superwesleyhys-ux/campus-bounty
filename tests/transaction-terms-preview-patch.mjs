// Development-only patch of three functions on the explicitly owned Task2A
// preview. Final migration validity is separately tested from scratch.
import { readFile } from "node:fs/promises";
import pg from "pg";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { localConfig, connectionString } from "../scripts/backend-local.mjs";
import { journal } from "./backend/transaction-terms-fixture.mjs";
const r = JSON.parse(
  await readFile(".data/backend/transaction-terms/release.json", "utf8"),
);
const t = JSON.parse(
  await readFile(
    ".superpowers/sdd/transaction-integration-plan/task-2a-targets.json",
    "utf8",
  ),
);
assert.equal(r.database, t.authorizedNewDatabaseNames[1]);
const ownership = await readFile(
  ".superpowers/sdd/transaction-integration-plan/task-2a-evidence/ownership.jsonl",
  "utf8",
);
assert.ok(ownership.includes(`"database":"${r.database}","action":"created"`));
const sql = await readFile(
  "backend/db/migrations/018_transaction_terms.sql",
  "utf8",
);
const c = new pg.Client({
  connectionString: connectionString(localConfig(), "migrator", r.database),
});
await c.connect();
try {
  await c.query("BEGIN");
  await c.query(
    "ALTER TABLE campus.payee_allocations ADD COLUMN component_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), ADD COLUMN funding_plan_lot_id uuid NOT NULL, ADD COLUMN source_plan_revision integer NOT NULL CHECK(source_plan_revision>0); ALTER TABLE campus.payee_allocations DROP CONSTRAINT payee_allocations_pkey; ALTER TABLE campus.payee_allocations ADD PRIMARY KEY(transaction_terms_id,funding_plan_lot_id,milestone_id,member_id);",
  );
  for (const name of ["transaction_plan", "bind_transaction_terms"]) {
    const start = sql.indexOf("CREATE FUNCTION campus." + name + "("),
      end = sql.indexOf("$$;", start) + 3;
    assert.ok(start > 0 && end > start);
    await c.query(
      sql
        .slice(start, end)
        .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
    );
  }
  await c.query("COMMIT");
  await journal({
    action: "owned_preview_function_patch",
    database: r.database,
    functions: ["transaction_plan", "bind_transaction_terms"],
    additiveColumns: [
      "component_id",
      "funding_plan_lot_id",
      "source_plan_revision",
    ],
    sourceSha256: createHash("sha256").update(sql).digest("hex"),
    migrationInventoryUnchanged: true,
  });
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  await c.end();
}
