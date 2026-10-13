import pg from "pg";
import { localConfig, connectionString } from "./backend-local.mjs";
import { migrate } from "../backend/db/migrate.mjs";
const local = process.argv.includes("--local");
if (!local && !process.env.CAMPUS_MIGRATION_URL)
  throw Error(
    "Use --local or supply CAMPUS_MIGRATION_URL through the secret manager.",
  );
const url = local
  ? connectionString(localConfig(), "migrator")
  : process.env.CAMPUS_MIGRATION_URL;
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const count = await migrate(client);
  console.log(`Applied ${count} backend migrations.`);
} finally {
  await client.end();
}
