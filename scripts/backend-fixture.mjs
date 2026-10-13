import pg from "pg";
import { localConfig, connectionString } from "./backend-local.mjs";
if (!process.argv.includes("--local") || process.env.NODE_ENV === "production")
  throw Error("Synthetic fixtures are local-only; pass --local.");
const client = new pg.Client({
  connectionString: connectionString(localConfig(), "migrator"),
});
await client.connect();
try {
  await client.query("BEGIN");
  const id = "00000000-0000-4000-8000-000000000001";
  await client.query(
    "INSERT INTO campus.institutions(id,name,active,review_evidence) VALUES($1,'Local Test University',true,'Synthetic localhost fixture. Not a real university.') ON CONFLICT DO NOTHING",
    [id],
  );
  await client.query(
    "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('campus.example.test',$1,true) ON CONFLICT DO NOTHING",
    [id],
  );
  await client.query("COMMIT");
  console.log(
    "Local test directory ready. Use a synthetic @campus.example.test address with the local mail sink.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
