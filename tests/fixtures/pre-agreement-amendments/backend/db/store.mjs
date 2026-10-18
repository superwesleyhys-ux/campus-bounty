import pg from "pg";
import { createHash } from "node:crypto";
import { Problem, requireThat } from "../errors.mjs";
export async function transaction(pool, actor, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='3s'",
    );
    if (actor)
      await client.query("SELECT set_config('campus.actor_id',$1,true)", [
        actor,
      ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
export function createStore(urls) {
  const pools = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => [
      role,
      new pg.Pool({
        connectionString: urls[role],
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
      }),
    ]),
  );
  for (const pool of Object.values(pools))
    pool.on("error", () => {
      console.error("Campus database connection lost.");
    });
  return {
    ...pools,
    as: (actor, fn) => transaction(pools.app, actor, fn),
    authTx: (fn) => transaction(pools.auth, null, fn),
    workerTx: (fn) => transaction(pools.worker, null, fn),
    async verifyRoles() {
      for (const [role, pool] of Object.entries(pools)) {
        const r = (
          await pool.query(
            `SELECT current_user AS name, session_user AS session_name,
                    r.rolsuper, r.rolbypassrls, r.rolcreaterole,
                    r.rolcreatedb, r.rolreplication, r.rolcanlogin,
                    n.oid IS NOT NULL AS schema_exists,
                    n.nspowner = r.oid AS owns_schema,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS has_membership,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS owns_database,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relowner = r.oid) AS owns_relation,
                    EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid AND p.proowner = r.oid) AS owns_function
             FROM pg_catalog.pg_roles r
             LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'campus'
             WHERE r.rolname = current_user`,
          )
        ).rows[0];
        if (
          !r ||
          r.name !== `campus_${role}` ||
          r.session_name !== r.name ||
          r.rolsuper ||
          r.rolbypassrls ||
          r.rolcreaterole ||
          r.rolcreatedb ||
          r.rolreplication ||
          !r.rolcanlogin ||
          !r.schema_exists ||
          r.has_membership ||
          r.owns_schema ||
          r.owns_database ||
          r.owns_relation ||
          r.owns_function
        )
          throw new Error("Unsafe backend database role");
      }
    },
    async close() {
      await Promise.all(Object.values(pools).map((p) => p.end()));
    },
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export async function idempotent(c, actor, operation, key, body, fn) {
  requireThat(
    typeof key === "string" && /^[\x21-\x7e]{8,128}$/.test(key),
    400,
    "idempotency_required",
    "Provide an Idempotency-Key of 8 to 128 visible ASCII characters.",
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(canonical(body)))
    .digest("hex");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([actor, operation, key]),
  ]);
  const old = (
    await c.query(
      "SELECT request_hash,response FROM campus.idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3",
      [actor, operation, key],
    )
  ).rows[0];
  if (old) {
    if (old.request_hash !== hash)
      throw new Problem(
        409,
        "idempotency_conflict",
        "This key was already used for a different request.",
      );
    return old.response;
  }
  const result = await fn();
  await c.query(
    "INSERT INTO campus.idempotency(actor_id,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5)",
    [actor, operation, key, hash, JSON.stringify(result)],
  );
  return JSON.parse(JSON.stringify(result));
}
export async function member(c, actor, { write = false, apply = false } = {}) {
  const row = (
    await c.query(
      "SELECT u.id,u.display_name,u.account_status,campus.eligible_student(u.id) AS can_apply FROM campus.users u JOIN campus.affiliations a ON a.user_id=u.id WHERE u.id=$1 AND campus.is_member()",
      [actor],
    )
  ).rows[0];
  requireThat(
    row,
    403,
    "membership_required",
    "A current verified campus membership is required.",
  );
  requireThat(
    !write || row.account_status === "active",
    403,
    "account_restricted",
    "This account cannot start new activity.",
  );
  requireThat(
    !apply || row.can_apply,
    403,
    "student_verification_required",
    "Verified student eligibility is required to apply.",
  );
  return row;
}
export async function audit(c, actor, action, id) {
  await c.query(
    "INSERT INTO campus.audit(actor_id,action,object_id) VALUES($1,$2,$3)",
    [actor, action, id],
  );
  await c.query("INSERT INTO campus.events(kind,object_id) VALUES($1,$2)", [
    action,
    id,
  ]);
}

export async function account(c, actor) {
  const row = (
    await c.query(
      "SELECT u.id,u.display_name,u.bio,u.account_status,a.institution_id,i.name AS institution_name,a.valid_until AS affiliation_valid_until,a.student_valid_until,campus.is_member() AS campus_verified,campus.eligible_student(u.id) AS can_apply,campus.can_review_eligibility() AS can_review_eligibility FROM campus.users u LEFT JOIN campus.affiliations a ON a.user_id=u.id LEFT JOIN campus.institutions i ON i.id=a.institution_id WHERE u.id=$1",
      [actor],
    )
  ).rows[0];
  requireThat(
    row && row.account_status !== "locked",
    403,
    "account_locked",
    "This account cannot access private resources.",
  );
  return row;
}
