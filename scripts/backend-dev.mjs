import { spawn } from "node:child_process";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import fs from "node:fs";
import { localConfig, connectionString } from "./backend-local.mjs";
import { createRuntime } from "../backend/runtime.mjs";
import { createMailWorker } from "../backend/adapters/mail-worker.mjs";
const config = localConfig(),
  port = Number(process.env.CAMPUS_DEV_PORT || 3020);
const mailDir = new URL("../.data/backend/mail/", import.meta.url);
fs.mkdirSync(mailDir, { recursive: true, mode: 0o700 });
// Local sink only: no outbound relay or real recipient delivery.
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, session, callback) {
    let data = "";
    stream.on("data", (d) => (data += d));
    stream.on("end", () => {
      fs.writeFileSync(new URL(Date.now() + ".eml", mailDir), data, {
        mode: 0o600,
      });
      callback();
    });
  },
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const env = {
  ...process.env,
  NODE_ENV: "development",
  CAMPUS_BACKEND: "postgres",
  CAMPUS_DEMO: "0",
  CAMPUS_BUILD_DIR: ".next-backend-dev",
  CAMPUS_ORIGIN: `http://127.0.0.1:${port}`,
  CAMPUS_DB_APP: connectionString(config, "app"),
  CAMPUS_DB_AUTH: connectionString(config, "auth"),
  CAMPUS_DB_WORKER: connectionString(config, "worker"),
  CAMPUS_OTP_KEY: config.otpKey,
  CAMPUS_MAIL_KEY: config.encryptionKey,
  CAMPUS_SMTP_HOST: "127.0.0.1",
  CAMPUS_SMTP_PORT: String(smtp.server.address().port),
  CAMPUS_MAIL_FROM: "Campus Bounty <noreply@campus.example.test>",
};
const runtime = await createRuntime(env),
  transport = nodemailer.createTransport(runtime.config.smtp),
  worker = createMailWorker(runtime.store, {
    encryptionKey: config.encryptionKey,
    transport,
    from: env.CAMPUS_MAIL_FROM,
  });
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await worker.tick();
    await runtime.market.expireReservations();
  } catch {
    console.error("Local backend worker could not finish its tick.");
  } finally {
    busy = false;
  }
}, 1000);
const next = spawn(
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
console.log(
  "Shared API uses isolated PostgreSQL. Local emails are saved privately under .data/backend/mail; no external mail is sent.",
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  next.kill("SIGTERM");
  transport.close();
  await new Promise((r) => smtp.close(r));
  await runtime.store.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
next.on("exit", () => void stop());
