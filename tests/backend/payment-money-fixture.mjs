import pg from "pg";
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
export const evidence = new URL(
  "../../.superpowers/sdd/transaction-integration-plan/task-2b2-evidence/",
  import.meta.url,
);
export const key = randomUUID;
export async function journal(v) {
  await mkdir(evidence, { recursive: true });
  await appendFile(
    new URL("ownership.jsonl", evidence),
    JSON.stringify({ at: new Date().toISOString(), ...v }) + "\n",
  );
}
export async function isolated(index = 0) {
  const targets = JSON.parse(
    await readFile(
      new URL(
        "../../.superpowers/sdd/transaction-integration-plan/task-2b2-targets.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const database = targets.databases[index % targets.databases.length];
  assert.ok(database && /^campus_r14_amendmoney_[a-f0-9]+$/.test(database));
  const config = localConfig(),
    admin = new pg.Client({
      connectionString: connectionString(config, "migrator"),
    });
  await admin.connect();
  assert.equal(
    (
      await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        database,
      ])
    ).rowCount,
    0,
    "Target must be absent",
  );
  await admin.query("CREATE DATABASE " + database);
  await journal({ database, action: "created", pid: process.pid });
  const owner = new pg.Client({
    connectionString: connectionString(config, "migrator", database),
  });
  await owner.connect();
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((r) => [
      r,
      connectionString(config, r, database),
    ]),
  );
  const store = createStore(urls);
  async function migrateThrough(version) {
    await owner.query(
      "CREATE SCHEMA IF NOT EXISTS campus;CREATE TABLE IF NOT EXISTS campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../../backend/db/migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => Number(n.slice(0, 3)) <= version)
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8"),
        checksum = createHash("sha256").update(sql).digest("hex");
      const old = (
        await owner.query(
          "SELECT checksum FROM campus.schema_migrations WHERE name=$1",
          [name],
        )
      ).rows[0];
      if (old) {
        assert.equal(old.checksum, checksum);
        continue;
      }
      await owner.query("BEGIN");
      try {
        await owner.query(sql);
        await owner.query(
          "INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await owner.query("COMMIT");
      } catch (e) {
        await owner.query("ROLLBACK");
        throw e;
      }
    }
  }
  const close = async () => {
    await store.close();
    await owner.end();
    await admin.query("DROP DATABASE " + database + " WITH (FORCE)");
    await journal({ database, action: "dropped" });
    await admin.end();
  };
  try {
    await migrateThrough(17);
    await store.verifyRoles();
    const institution = key();
    await owner.query(
      "INSERT INTO campus.institutions VALUES($1,'Transaction Synthetic University',true,'Task2B isolated fixture')",
      [institution],
    );
    await owner.query(
      "INSERT INTO campus.domains VALUES('transaction.example.test',$1,true)",
      [institution],
    );
    return {
      database,
      owner,
      store,
      urls,
      config,
      market: createMarket(store,{paymentEnabled:true}),
      migrateThrough,
      close,
      async user(name) {
        const id = key();
        await owner.query(
          "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
          [id, name],
        );
        await owner.query(
          "INSERT INTO campus.affiliations VALUES($1,$2,'transaction.example.test',now()+interval '1 year',true)",
          [id, institution],
        );
        return id;
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}

// Scenario-only owner policy: these words are saved, not inferred by the client from IDs.
export function syntheticPolicyPayload(fee = 601, principal = 20000) {
  return {
    kind: "exact_charge_estimate",
    estimatedProcessorFeeCents: fee,
    chargeTotalCents: principal + Math.ceil(fee / 2),
    feeAdjustmentPolicyId: "synthetic-hold-on-variance",
    taxPolicyId: "synthetic-no-tax",
    refundPolicyId: "synthetic-no-refund-execution",
    disclosure: {
      format: "transaction_policy_disclosure_v1",
      feeAdjustment: {
        policyId: "synthetic-hold-on-variance",
        version: "synthetic-v1",
        title: "Processing fee differences",
        description:
          "Synthetic scenario only: if the actual processing fee differs from this estimate, settlement stays on hold until revised terms and required confirmations are separately approved. No automatic extra charge, recipient deduction, platform absorption or refund is authorized.",
      },
      tax: {
        policyId: "synthetic-no-tax",
        version: "synthetic-v1",
        title: "Tax treatment",
        description:
          "Synthetic scenario only: no tax amount is calculated or collected in this fixture. This is not a determination that a real transaction is tax-exempt. Real tax-dependent operations remain blocked until an approved tax policy is provided.",
      },
      refund: {
        policyId: "synthetic-no-refund-execution",
        version: "synthetic-v1",
        title: "Refund restriction",
        description:
          "Synthetic scenario only: refund execution is unavailable. A refund remains blocked until separate refund rules and any required confirmations are approved; this consent does not waive rights or authorize a refund.",
      },
    },
  };
}

// Hash every existing campus table before the additive migrations; only synthetic
// service-created fixture data is involved. Never emit row bodies or credentials.
export async function snapshotExistingTables(owner, names) {
  const tables =
    names ??
    (
      await owner.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='campus' AND tablename<>'schema_migrations' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);
  const result = [];
  for (const name of tables) {
    assert.match(name, /^[a-z_]+$/);
    const data = (
      await owner.query(
        `SELECT count(*)::int AS count,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM campus.${name} t`,
      )
    ).rows[0];
    result.push({
      table: name,
      count: data.count,
      digest: createHash("sha256")
        .update(JSON.stringify(data.data))
        .digest("hex"),
    });
  }
  return result;
}

export async function controlledMoneyClock(f) {
 let current=Date.now();
 await f.owner.query('CREATE TABLE campus.fixture_money_clock(value timestamptz NOT NULL)');
 await f.owner.query('REVOKE ALL ON campus.fixture_money_clock FROM PUBLIC,campus_app,campus_auth,campus_worker');
 await f.owner.query('INSERT INTO campus.fixture_money_clock VALUES($1)',[new Date(current)]);
 await f.owner.query("CREATE OR REPLACE FUNCTION campus.money_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog,campus AS $$ SELECT value FROM campus.fixture_money_clock $$");
 return {now:()=>current,async advance(ms){current+=ms;await f.owner.query('UPDATE campus.fixture_money_clock SET value=$1',[new Date(current)]);}};
}
// Explicit scenario authority for old policy cases, never a production default.
export async function legacyInlineProfile(f,environmentId){
 await f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) SELECT id,1,platform_account_id,'inline',$2,'Synthetic: old-version fixture original charge balance closes modeled fee' FROM campus.payment_environments WHERE id=$1",[environmentId,JSON.stringify({kind:'synthetic_original_charge_balance_v1',source:'tests/backend/payment-money-fixture.mjs',model:'single original processing fee; later corrections held'})]);
}
