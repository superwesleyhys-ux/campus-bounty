import {
  randomUUID,
  randomInt,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { hash, mac, seal, secretKey } from "../crypto.mjs";
import { Problem, parse, requireThat } from "../errors.mjs";
const emailSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((v) => v.toLowerCase()),
});
const verifySchema = z.strictObject({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  displayName: z.string().trim().min(1).max(100),
});
async function rate(c, bucket, max) {
  const row = (
    await c.query(
      `INSERT INTO campus.rate_limits(bucket,hits,reset_at) VALUES($1,1,now()+interval '15 minutes')
 ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN campus.rate_limits.reset_at<=now() THEN 1 ELSE campus.rate_limits.hits+1 END,
 reset_at=CASE WHEN campus.rate_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE campus.rate_limits.reset_at END RETURNING hits`,
      [bucket],
    )
  ).rows[0];
  return row.hits <= max;
}
export function createAuth(store, config) {
  secretKey(config.otpKey);
  secretKey(config.encryptionKey);
  const bucket = (v) => mac(config.otpKey, v);
  return {
    async request(input, ip) {
      const { email } = parse(emailSchema, input),
        id = randomUUID();
      const outcome = await store.authTx(async (c) => {
        const okIP = await rate(c, bucket("request-ip:" + ip), 20);
        const okEmail = await rate(c, bucket("request-email:" + email), 3);
        if (!okIP || !okEmail) return "rate";
        const domain = email.split("@")[1];
        const school = (
          await c.query(
            "SELECT d.institution_id FROM campus.domains d JOIN campus.institutions i ON i.id=d.institution_id WHERE d.domain=$1 AND d.enabled AND i.active",
            [domain],
          )
        ).rows[0];
        // Reject only by the public, reviewed domain directory. Do not reveal
        // whether a particular mailbox or account already exists.
        if (!school) return "unsupported_domain";
        const code = String(randomInt(0, 1000000)).padStart(6, "0");
        await c.query(
          "INSERT INTO campus.challenges(id,email,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
          [id, email, mac(config.otpKey, id + ":" + code)],
        );
        await c.query(
          "INSERT INTO campus.mail_jobs(payload,expires_at) VALUES($1,now()+interval '10 minutes')",
          [seal(config.encryptionKey, { to: email, code, challengeId: id })],
        );
        return "ok";
      });
      if (outcome === "rate")
        throw new Problem(
          429,
          "rate_limited",
          "Too many attempts. Try again later.",
        );
      if (outcome === "unsupported_domain")
        throw new Problem(
          422,
          "unsupported_university_email",
          "This email domain is not supported. Use an email from a university in our approved U.S. university directory. Personal email addresses are not accepted.",
        );
      return {
        challengeId: id,
        message:
          "Your university email domain is supported. A sign-in code has been queued; check your inbox shortly.",
      };
    },
    async verify(input, ip) {
      const data = parse(verifySchema, input);
      const result = await store.authTx(async (c) => {
        if (!(await rate(c, bucket("verify-ip:" + ip), 40)))
          return { failure: "rate" };
        const challenge = (
          await c.query(
            "SELECT *,expires_at>clock_timestamp() AS valid FROM campus.challenges WHERE id=$1 FOR UPDATE",
            [data.challengeId],
          )
        ).rows[0];
        if (
          !challenge ||
          !challenge.valid ||
          challenge.consumed_at ||
          challenge.attempts >= 5
        )
          return { failure: "invalid" };
        await c.query(
          "UPDATE campus.challenges SET attempts=attempts+1 WHERE id=$1",
          [data.challengeId],
        );
        if (
          !timingSafeEqual(
            Buffer.from(challenge.code_hash, "hex"),
            Buffer.from(
              mac(config.otpKey, data.challengeId + ":" + data.code),
              "hex",
            ),
          )
        )
          return { failure: "invalid" };
        const domain = challenge.email.split("@")[1];
        const school = (
          await c.query(
            "SELECT d.institution_id FROM campus.domains d JOIN campus.institutions i ON i.id=d.institution_id WHERE d.domain=$1 AND d.enabled AND i.active",
            [domain],
          )
        ).rows[0];
        if (!school) return { failure: "invalid" };
        // Keep attempt/rate counters, but roll back any identity changes if a
        // lock wait takes us past the code's deadline before consumption.
        await c.query("SAVEPOINT identity_verification");
        // Serializes separate valid challenges for the same email, preventing duplicate identities.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          challenge.email,
        ]);
        let user = (
          await c.query(
            "SELECT u.* FROM campus.identities i JOIN campus.users u ON u.id=i.user_id WHERE email=$1 FOR UPDATE OF u",
            [challenge.email],
          )
        ).rows[0];
        if (user?.account_status === "locked") return { failure: "invalid" };
        if (!user) {
          user = (
            await c.query(
              "INSERT INTO campus.users(display_name) VALUES($1) RETURNING id,display_name,account_status",
              [data.displayName],
            )
          ).rows[0];
          await c.query(
            "INSERT INTO campus.identities(email,user_id,domain,verified_at) VALUES($1,$2,$3,now())",
            [challenge.email, user.id, domain],
          );
        }
        await c.query(
          "INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until) VALUES($1,$2,$3,now()+interval '180 days') ON CONFLICT(user_id) DO UPDATE SET valid_until=excluded.valid_until",
          [user.id, school.institution_id, domain],
        );
        const consumed = await c.query(
          "UPDATE campus.challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id",
          [data.challengeId],
        );
        if (!consumed.rowCount) {
          await c.query("ROLLBACK TO SAVEPOINT identity_verification");
          return { failure: "invalid" };
        }
        await c.query("RELEASE SAVEPOINT identity_verification");
        const token = randomBytes(32).toString("base64url");
        await c.query(
          "INSERT INTO campus.sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '7 days')",
          [hash(token), user.id],
        );
        return {
          token,
          user: {
            id: user.id,
            display_name: user.display_name,
            account_status: user.account_status,
          },
        };
      });
      if (result.failure)
        throw new Problem(
          result.failure === "rate" ? 429 : 401,
          result.failure === "rate" ? "rate_limited" : "invalid_code",
          result.failure === "rate"
            ? "Too many attempts. Try again later."
            : "The verification code is invalid or expired.",
        );
      return result;
    },
    async resolve(token) {
      requireThat(
        typeof token === "string" && /^[\w-]{43}$/.test(token),
        401,
        "unauthenticated",
        "Sign in to continue.",
      );
      const user = (
        await store.auth.query(
          "SELECT u.id,u.display_name,u.account_status FROM campus.sessions s JOIN campus.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.account_status<>'locked'",
          [hash(token)],
        )
      ).rows[0];
      requireThat(user, 401, "unauthenticated", "Sign in to continue.");
      return user;
    },
    async limitBusiness(actor) {
      const ok = await store.authTx((c) =>
        rate(c, bucket("business:" + actor), 120),
      );
      if (!ok)
        throw new Problem(
          429,
          "rate_limited",
          "Too many requests. Try again later.",
        );
    },
    async logout(token) {
      if (typeof token === "string")
        await store.auth.query(
          "UPDATE campus.sessions SET revoked_at=now() WHERE token_hash=$1",
          [hash(token)],
        );
    },
  };
}
