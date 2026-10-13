// Connection/authentication preflight only. Never sends mail or prints secrets.
import nodemailer from "nodemailer";
import { mailConfig, senderAddress } from "../backend/adapters/mail-config.mjs";
const required = [
  "CAMPUS_SMTP_HOST",
  "CAMPUS_SMTP_USER",
  "CAMPUS_SMTP_PASSWORD",
  "CAMPUS_MAIL_FROM",
];
const missing = required.filter((key) => !process.env[key]);
let transport;
try {
  if (missing.length) throw Error("missing_configuration");
  const smtp = mailConfig(process.env, true);
  const domain = senderAddress(process.env.CAMPUS_MAIL_FROM).split("@")[1];
  if (/\.(test|invalid|localhost|local)$/.test(domain) || !domain.includes("."))
    throw Error("synthetic_sender");
  transport = nodemailer.createTransport(smtp);
  await transport.verify();
  console.log(
    JSON.stringify({
      status: "smtp_connection_verified",
      messageSent: false,
      inboxReceipt: "NOT_RUN",
      senderAuthorization: "NOT_PROVEN_BY_VERIFY",
      schoolLogin: "NOT_RUN",
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      status: "blocked",
      missing,
      reason: missing.length
        ? "missing_configuration"
        : error.message === "synthetic_sender"
          ? "synthetic_sender"
          : "smtp_connection_failed",
      messageSent: false,
      inboxReceipt: "NOT_RUN",
      schoolLogin: "NOT_RUN",
    }),
  );
  process.exitCode = 1;
} finally {
  transport?.close();
}
