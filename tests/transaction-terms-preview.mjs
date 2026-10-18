import { spawn } from "node:child_process";
import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { isolated, journal } from "./backend/transaction-terms-fixture.mjs";
import { createMailWorker } from "../backend/adapters/mail-worker.mjs";
const port = 3022,
  folder = new URL("../.data/backend/transaction-terms-fix1/", import.meta.url);
const probe = net.createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise((r) => probe.close(r));
const f = await isolated(1);
await f.migrateThrough(18);
await mkdir(folder, { recursive: true, mode: 0o700 });
const users = {},
  recipients = {};
for (const role of ["publisher", "captain", "member"]) {
  users[role] = await f.user(`T2A ${role}`);
  recipients[role] = `${role}@transaction.example.test`;
  await f.owner.query(
    "INSERT INTO campus.identities VALUES($1,$2,'transaction.example.test',now())",
    [recipients[role], users[role]],
  );
}
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, session, callback) {
    let data = "";
    stream.on("data", (d) => (data += d));
    stream.on("end", async () => {
      const role = Object.keys(recipients).find((r) =>
        session.envelope.rcptTo.some((x) => x.address === recipients[r]),
      );
      if (!role) return callback(Error("Synthetic recipient required"));
      await writeFile(new URL(`${role}.eml`, folder), data, { mode: 0o600 });
      callback();
    });
  },
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const transport = nodemailer.createTransport({
  host: "127.0.0.1",
  port: smtp.server.address().port,
  secure: false,
  ignoreTLS: true,
});
const worker = createMailWorker(f.store, {
  encryptionKey: f.config.encryptionKey,
  transport,
  from: "Campus Bounty <noreply@transaction.example.test>",
});
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await worker.tick();
  } catch {
    console.error("Synthetic local mail tick failed");
  } finally {
    busy = false;
  }
}, 250);
const env = {
  ...process.env,
  NODE_ENV: "development",
  CAMPUS_BACKEND: "postgres",
  CAMPUS_DEMO: "0",
  CAMPUS_BUILD_DIR: ".next-backend-transaction-fix1",
  CAMPUS_ORIGIN: `http://127.0.0.1:${port}`,
  CAMPUS_DB_APP: f.urls.app,
  CAMPUS_DB_AUTH: f.urls.auth,
  CAMPUS_DB_WORKER: f.urls.worker,
  CAMPUS_OTP_KEY: f.config.otpKey,
  CAMPUS_MAIL_KEY: f.config.encryptionKey,
  CAMPUS_SMTP_HOST: "127.0.0.1",
  CAMPUS_SMTP_PORT: String(smtp.server.address().port),
  CAMPUS_MAIL_FROM: "Campus Bounty <noreply@transaction.example.test>",
};
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  { env, stdio: "inherit" },
);
await writeFile(
  new URL("release.json", folder),
  JSON.stringify({
    origin: env.CAMPUS_ORIGIN,
    database: f.database,
    users,
    recipients,
    pid: process.pid,
    nextPid: child.pid,
  }),
  { mode: 0o600 },
);
await journal({
  action: "preview_started",
  database: f.database,
  pid: process.pid,
  nextPid: child.pid,
  port,
  mail: "local synthetic SMTP only",
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  transport.close();
  await new Promise((r) => smtp.close(r));
  await f.close();
  await journal({ action: "preview_stopped", pid: process.pid, port });
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
