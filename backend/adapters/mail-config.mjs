import { z } from "zod";

// One operator-configured sender; reject lists, header injection and groups.
export function senderAddress(from) {
  if (typeof from !== "string" || /[\r\n]/.test(from))
    throw Error("Invalid mail sender");
  const match = from.trim().match(/^(?:[^<>,;]+<([^<>]+)>|([^<>]+))$/);
  const address = (match?.[1] || match?.[2] || "").trim();
  if (!z.email().safeParse(address).success) throw Error("Invalid mail sender");
  return address.toLowerCase();
}

export function mailConfig(env, production) {
  const host = env.CAMPUS_SMTP_HOST;
  const localSink =
    !production && ["127.0.0.1", "localhost", "::1"].includes(host);
  if (
    !host ||
    !env.CAMPUS_MAIL_FROM ||
    (!localSink && (!env.CAMPUS_SMTP_USER || !env.CAMPUS_SMTP_PASSWORD))
  )
    throw Error("SMTP configuration is required");
  senderAddress(env.CAMPUS_MAIL_FROM);
  const port = Number(env.CAMPUS_SMTP_PORT || 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid SMTP port");
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: !localSink,
    ignoreTLS: localSink,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: env.CAMPUS_SMTP_USER
      ? { user: env.CAMPUS_SMTP_USER, pass: env.CAMPUS_SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
