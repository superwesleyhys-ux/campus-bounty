import pg from "pg";
import { randomUUID } from "node:crypto";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
import { migrate } from "../../backend/db/migrate.mjs";
export async function fixture() {
  const config = localConfig(),
    database = "campus_test_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({
    connectionString: connectionString(config, "migrator"),
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const owner = new pg.Client({
    connectionString: connectionString(config, "migrator", database),
  });
  await owner.connect();
  await migrate(owner);
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => [
      role,
      connectionString(config, role, database),
    ]),
  );
  const institution = randomUUID();
  await owner.query(
    "INSERT INTO campus.institutions VALUES($1,'Test University',true,'Local synthetic fixture only')",
    [institution],
  );
  await owner.query(
    "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('campus.example.test',$1,true)",
    [institution],
  );
  return {
    config,
    urls,
    owner,
    institution,
    async user(name, canApply = true) {
      const id = randomUUID();
      await owner.query(
        "INSERT INTO campus.users(id,display_name) VALUES($1,$2)",
        [id, name],
      );
      await owner.query(
        "INSERT INTO campus.affiliations VALUES($1,$2,'campus.example.test',now()+interval '1 year',$3)",
        [id, institution, canApply],
      );
      return id;
    },
    async close() {
      await owner.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    },
  };
}
