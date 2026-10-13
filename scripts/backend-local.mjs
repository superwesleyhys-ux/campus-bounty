import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { fileURLToPath } from "node:url";
const dir = new URL("../.data/backend/", import.meta.url);
const configFile = new URL("local.json", dir);
const run = (args, options = {}) => {
  const r = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (r.status !== 0) throw new Error(r.stderr || "Docker command failed");
  return r.stdout.trim();
};
export function localConfig() {
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}
export async function startLocalDatabase() {
  const endpoint = run([
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (!endpoint.startsWith("unix://"))
    throw new Error("Local development requires a local Docker socket");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) {
    const config = {
      port: 5443,
      database: "campus_development",
      migrator: randomBytes(24).toString("hex"),
      app: randomBytes(24).toString("hex"),
      auth: randomBytes(24).toString("hex"),
      worker: randomBytes(24).toString("hex"),
      encryptionKey: randomBytes(32).toString("hex"),
      otpKey: randomBytes(32).toString("hex"),
    };
    fs.writeFileSync(configFile, JSON.stringify(config), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const config = localConfig();
  const name = "campus-bounty-backend-db";
  const existing = run([
    "ps",
    "-a",
    "--filter",
    `name=^/${name}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (existing) {
    if (
      run([
        "inspect",
        name,
        "--format",
        '{{index .Config.Labels "campus.project"}}',
      ]) !== "campus-bounty-backend"
    )
      throw new Error("Container name belongs to another project");
    run(["start", name]);
  } else {
    const envFile = new URL("postgres.env", dir);
    fs.writeFileSync(
      envFile,
      `POSTGRES_USER=campus_migrator\nPOSTGRES_PASSWORD=${config.migrator}\nPOSTGRES_DB=${config.database}\n`,
      { mode: 0o600 },
    );
    run([
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "campus.project=campus-bounty-backend",
      "--memory=512m",
      "--cpus=1",
      "-p",
      `127.0.0.1:${config.port}:5432`,
      "--mount",
      "type=volume,source=campus-bounty-backend-pgdata,target=/var/lib/postgresql/data",
      "--env-file",
      fileURLToPath(envFile),
      "postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
    ]);
  }
  for (let n = 0; n < 30; n++) {
    const p = new pg.Client({
      connectionString: connectionString(config, "migrator"),
    });
    try {
      await p.connect();
      for (const role of ["app", "auth", "worker"]) {
        const user = `campus_${role}`;
        const exists = await p.query(
          "SELECT 1 FROM pg_roles WHERE rolname=$1",
          [user],
        );
        if (!exists.rowCount)
          await p.query(
            `CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${pg.escapeLiteral(config[role])}`,
          );
      }
      await p.end();
      console.log(
        "Isolated local PostgreSQL ready on 127.0.0.1:5443; credentials stay in ignored .data/backend/local.json",
      );
      return;
    } catch (e) {
      await p.end().catch(() => {});
      if (n === 29) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
export function connectionString(config, role, database = config.database) {
  return `postgresql://campus_${role}:${config[role]}@127.0.0.1:${config.port}/${database}`;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await startLocalDatabase();
