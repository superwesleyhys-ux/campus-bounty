// This is a disposable browser-fixture entry, never a general development login.
// Every request rechecks the running configuration and private fixture metadata.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hash } from "../crypto.mjs";
import { parse, requireThat } from "../errors.mjs";
import { sessionCookie } from "../http/endpoint.mjs";
const identities = Object.freeze({
  student: "alex",
  applicant: "sam",
  publisher: "professor",
});
const roleSchema = z.strictObject({
  role: z.enum(["student", "applicant", "publisher"]),
});
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function previewFixture(
  config,
  env = process.env,
  readMetadata = () =>
    JSON.parse(
      readFileSync(
        join(process.cwd(), ".data/backend/interaction/fixture.json"),
        "utf8",
      ),
    ),
) {
  try {
    if (
      env.NODE_ENV !== "development" ||
      config.production !== false ||
      env.CAMPUS_BACKEND !== "postgres" ||
      env.CAMPUS_DEMO !== "0" ||
      env.CAMPUS_BUILD_DIR !== ".next-interaction" ||
      env.CAMPUS_ORIGIN !== "http://127.0.0.1:3020" ||
      config.origin !== env.CAMPUS_ORIGIN ||
      env.CAMPUS_SMTP_HOST !== "127.0.0.1" ||
      env.CAMPUS_SMTP_PORT !== "1" ||
      env.CAMPUS_MAIL_FROM !== "local@campus.example.test"
    )
      return null;
    const urls = ["app", "auth", "worker"].map((role) => {
      const url = new URL(config.urls[role]);
      if (
        config.urls[role] !== env[`CAMPUS_DB_${role.toUpperCase()}`] ||
        url.protocol !== "postgresql:" ||
        url.hostname !== "127.0.0.1" ||
        url.username !== `campus_${role}` ||
        !url.password ||
        !url.port ||
        url.search ||
        url.hash ||
        !/^\/campus_test_[a-f0-9]{32}$/.test(url.pathname)
      )
        throw Error();
      return url;
    });
    if (
      urls.some(
        (url) => url.host !== urls[0].host || url.pathname !== urls[0].pathname,
      )
    )
      return null;
    const fixture = readMetadata();
    if (
      fixture.database !== urls[0].pathname.slice(1) ||
      !Object.values(identities).every((name) =>
        uuid.test(fixture.users?.[name]),
      ) ||
      new Set(Object.values(identities).map((name) => fixture.users[name]))
        .size !== 3
    )
      return null;
    return fixture;
  } catch {
    return null;
  }
}
async function fixtureUsers(client, fixture, lock = false) {
  return (
    await client.query(
      `SELECT u.id,u.display_name,u.account_status,i.email
    FROM campus.identities i JOIN campus.users u ON u.id=i.user_id
    JOIN campus.affiliations a ON a.user_id=u.id AND a.domain=i.domain
    JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id
    JOIN campus.institutions n ON n.id=d.institution_id
    WHERE ((u.id=$1 AND i.email='alex@campus.example.test') OR
           (u.id=$2 AND i.email='professor@campus.example.test') OR
           (u.id=$3 AND i.email='sam@campus.example.test'))
      AND i.domain='campus.example.test' AND i.verified_at IS NOT NULL
      AND u.account_status='active' AND a.valid_until>clock_timestamp() AND d.enabled AND n.active
    ${lock ? "FOR SHARE OF u,i,a" : ""}`,
      [fixture.users.alex, fixture.users.professor, fixture.users.sam],
    )
  ).rows;
}
export async function previewAvailable(
  runtime,
  env = process.env,
  readMetadata,
) {
  const fixture = previewFixture(runtime.config, env, readMetadata);
  if (!fixture) return false;
  return (await fixtureUsers(runtime.store.auth, fixture)).length === 3;
}
export async function enterPreview(
  { runtime, body, token },
  env = process.env,
  readMetadata,
) {
  const fixture = previewFixture(runtime.config, env, readMetadata);
  requireThat(
    fixture,
    404,
    "not_found",
    "Sample-account entry is unavailable.",
  );
  const { role } = parse(roleSchema, body);
  const result = await runtime.store.authTx(async (client) => {
    const users = await fixtureUsers(client, fixture, true);
    requireThat(
      users.length === 3,
      404,
      "not_found",
      "Sample-account entry is unavailable.",
    );
    const user = users.find(
      (user) => user.id === fixture.users[identities[role]],
    );
    // Bound public entry attempts; normal session cookies and logout apply.
    const rate = (
      await client.query(`INSERT INTO campus.rate_limits(bucket,hits,reset_at)
      VALUES('local-preview-entry',1,now()+interval '15 minutes')
      ON CONFLICT(bucket) DO UPDATE SET
      hits=CASE WHEN campus.rate_limits.reset_at<=now() THEN 1 ELSE campus.rate_limits.hits+1 END,
      reset_at=CASE WHEN campus.rate_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE campus.rate_limits.reset_at END RETURNING hits`)
    ).rows[0];
    requireThat(
      rate.hits <= 40,
      429,
      "rate_limited",
      "Too many attempts. Try again later.",
    );
    if (token)
      await client.query(
        "UPDATE campus.sessions SET revoked_at=now() WHERE token_hash=$1",
        [hash(token)],
      );
    const session = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO campus.sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '7 days')",
      [hash(session), user.id],
    );
    return {
      session,
      user: {
        id: user.id,
        display_name: user.display_name,
        account_status: user.account_status,
      },
    };
  });
  return Response.json(
    { user: result.user, sample: true },
    {
      headers: { "Set-Cookie": sessionCookie(runtime.config, result.session) },
    },
  );
}
