import { secretKey } from "./crypto.mjs";
import pg from "pg";
import { mailConfig } from "./adapters/mail-config.mjs";
const databaseOptions = new Set([
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "application_name",
]);
export function readConfig(env = process.env) {
  if (env.CAMPUS_BACKEND !== "postgres")
    throw Error("CAMPUS_BACKEND must be postgres");
  if (env.CAMPUS_DEMO === "1")
    throw Error("Shared backend cannot enable demo authentication");
  const production = env.NODE_ENV === "production";
  const origin = new URL(env.CAMPUS_ORIGIN || "invalid");
  if (origin.origin !== env.CAMPUS_ORIGIN)
    throw Error("CAMPUS_ORIGIN must be an exact origin");
  if (production && origin.protocol !== "https:")
    throw Error("Production requires HTTPS");
  if (!production && !["localhost", "127.0.0.1"].includes(origin.hostname))
    throw Error("Development must bind to loopback");
  const urls = Object.fromEntries(
    ["app", "auth", "worker"].map((role) => {
      const value = env["CAMPUS_DB_" + role.toUpperCase()],
        url = new URL(value || "invalid");
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        url.username !== `campus_${role}` ||
        !url.password
      )
        throw Error("Invalid database configuration");
      // pg takes the last query value and lets query options override the URL
      // authority. Reject ambiguity and unsupported overrides before parsing.
      const seen = new Set();
      for (const name of url.searchParams.keys()) {
        if (seen.has(name) || !databaseOptions.has(name))
          throw Error("Ambiguous or unsupported PostgreSQL URL parameter");
        seen.add(name);
      }
      if (production && url.searchParams.get("sslmode") !== "verify-full")
        throw Error("Production PostgreSQL requires sslmode=verify-full");
      if (!production && !["localhost", "127.0.0.1"].includes(url.hostname))
        throw Error("Development PostgreSQL must be local");
      const connectionString = url.toString();
      let actual;
      try {
        // The same installed pg parser used by the pool, without opening a socket.
        actual = new pg.Client({ connectionString }).connectionParameters;
      } catch {
        throw Error("Invalid database connection options");
      }
      if (
        actual.user !== `campus_${role}` ||
        actual.host !== url.hostname.replace(/^\[|\]$/g, "") ||
        actual.password !== decodeURIComponent(url.password)
      )
        throw Error("Database URL and driver configuration disagree");
      if (
        production &&
        (!actual.ssl ||
          actual.ssl.rejectUnauthorized === false ||
          actual.ssl.checkServerIdentity)
      )
        throw Error("Production PostgreSQL requires verified TLS");
      return [role, connectionString];
    }),
  );
  secretKey(env.CAMPUS_OTP_KEY);
  secretKey(env.CAMPUS_MAIL_KEY);
  const smtp = mailConfig(env, production);
  return {
    production,
    origin: origin.origin,
    urls,
    otpKey: env.CAMPUS_OTP_KEY,
    encryptionKey: env.CAMPUS_MAIL_KEY,
    from: env.CAMPUS_MAIL_FROM,
    smtp,
    proxySecret: env.CAMPUS_PROXY_SECRET,
    cookieName: production ? "__Host-campus_session" : "campus_session",
  };
}
