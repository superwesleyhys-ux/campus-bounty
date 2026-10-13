import { z } from "zod";
import { parse, found, requireThat } from "../errors.mjs";
import { member, account, idempotent, audit } from "../db/store.mjs";
export { z, parse, found, requireThat };
export const uuid = (v) => parse(z.uuid(), v),
  empty = z.strictObject({}),
  title = z.string().trim().min(1).max(160),
  text = z.string().trim().min(1).max(10000);
export const money = z.number().int().min(1).max(100000000);
export function context(store) {
  return {
    read: (actor, fn) =>
      store.as(actor, async (c) => {
        await member(c, actor);
        return fn(c);
      }),
    privateRead: (actor, fn) =>
      store.as(actor, async (c) => {
        await account(c, actor);
        return fn(c);
      }),
    command: (actor, op, key, input, fn, apply = false) =>
      store.as(actor, async (c) => {
        await member(c, actor, { write: true, apply });
        return idempotent(c, actor, op, key, input, async () => {
          const result = await fn(c);
          await audit(c, actor, op, result.id || actor);
          return result;
        });
      }),
  };
}
export async function lockTeam(c, id) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "team:" + id,
  ]);
}
export async function eligible(c, ids) {
  const result = await c.query(
    "SELECT bool_and(campus.eligible_student(u)) AS ok FROM unnest($1::uuid[]) u",
    [ids],
  );
  requireThat(
    result.rows[0].ok,
    403,
    "student_verification_required",
    "All participants must have current student eligibility.",
  );
}
export function pagination(input) {
  return parse(
    z.strictObject({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).max(10000).default(0),
    }),
    input,
  );
}

export function catalogQuery(input, tasks = false) {
  const schema = {
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    q: z.string().trim().max(120).default(""),
    sort: z.enum(["recent", "amount_asc", "amount_desc"]).default("recent"),
    scope: z.enum(["all", "mine"]).default("all"),
    ...(tasks
      ? {
          category: z
            .enum([
              "Research",
              "Design",
              "Engineering",
              "Writing",
              "Campus",
              "Other",
            ])
            .optional(),
        }
      : {}),
  };
  return parse(z.strictObject(schema), input);
}
export const searchPattern = (q) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

export async function lockTask(c, id) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "task:" + id,
  ]);
}
