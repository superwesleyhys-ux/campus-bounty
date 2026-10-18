import { createHash } from "node:crypto";
export const CALCULATION_VERSION = "charge_member_stage_v1";
export const MAX_CENTS = 100000000;
const fail = (code = "invalid_amount") => {
  throw Object.assign(new RangeError(code), { code });
};
export function integer(n, max = MAX_CENTS) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) fail();
  return n;
}
export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    integer(value, Number.MAX_SAFE_INTEGER);
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  fail("invalid_canonical_value");
}
export const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function largestRemainder(amount, weights, keys) {
  integer(amount);
  if (
    !Array.isArray(weights) ||
    weights.length !== keys.length ||
    new Set(keys).size !== keys.length ||
    keys.some((k) => typeof k !== "string")
  )
    fail();
  weights.forEach((w) => integer(w));
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (!sum) {
    if (amount) fail("fee_exceeds_component");
    return weights.map(() => 0);
  }
  const rows = weights.map((w, i) => ({
    i,
    key: keys[i],
    w,
    n: BigInt(amount) * BigInt(w),
  }));
  const result = rows.map((r) => Number(r.n / sum));
  let left = amount - result.reduce((a, b) => a + b, 0);
  rows
    .filter((r) => r.w > 0)
    .sort((a, b) =>
      a.n % sum === b.n % sum
        ? a.key < b.key
          ? -1
          : 1
        : a.n % sum > b.n % sum
          ? -1
          : 1,
    )
    .forEach((r) => {
      if (left > 0) {
        result[r.i]++;
        left--;
      }
    });
  return result;
}
export function ratios(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100)
    fail("invalid_ratios");
  const result = input
    .map(({ memberId, units }) => ({ memberId, units: integer(units, 10000) }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  if (
    result.some(
      (r) =>
        r.units === 0 ||
        typeof r.memberId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          r.memberId,
        ),
    ) ||
    new Set(result.map((r) => r.memberId)).size !== result.length ||
    result.reduce((s, r) => s + r.units, 0) !== 10000
  )
    fail("invalid_ratios");
  return result;
}
// Fees are estimates only. No input to this arithmetic function authorizes money.
export function componentPlan({ members, lots }) {
  const rs = ratios(members),
    weights = rs.map((r) => r.units),
    keys = rs.map((r) => r.memberId);
  if (
    !Array.isArray(lots) ||
    !lots.length ||
    new Set(lots.map((l) => l.fundingPlanLotId)).size !== lots.length
  )
    fail("invalid_lots");
  const planned = lots
    .map((l) => {
      if (typeof l.fundingPlanLotId !== "string" || !l.fundingPlanLotId)
        fail("invalid_lots");
      const stages = [...l.stages].sort(
        (a, b) =>
          a.position - b.position || (a.milestoneId < b.milestoneId ? -1 : 1),
      );
      if (
        !stages.length ||
        new Set(stages.map((s) => s.position)).size !== stages.length
      )
        fail("invalid_stages");
      stages.forEach((s) => {
        integer(s.position, 2147483647);
        if (!s.position || typeof s.milestoneId !== "string")
          fail("invalid_stages");
        integer(s.grossCents);
      });
      const principalCents = integer(
        stages.reduce((s, m) => s + m.grossCents, 0),
      );
      const fee =
        l.estimatedProcessorFeeCents === null
          ? null
          : integer(l.estimatedProcessorFeeCents);
      const publisher = fee === null ? null : Math.ceil(fee / 2),
        recipient = fee === null ? null : Math.floor(fee / 2);
      const gross = stages.map((s) =>
        largestRemainder(s.grossCents, weights, keys),
      );
      // Explicit incremental member gross is for separately assessed top-up lots, never silently reapportioned.
      if (l.memberGross) {
        if (l.memberGross.length !== stages.length) fail("invalid_components");
        for (let si = 0; si < stages.length; si++) {
          const rows = l.memberGross.find(
            (r) => r.position === stages[si].position,
          )?.members;
          if (
            !rows ||
            rows.length !== rs.length ||
            new Set(rows.map((r) => r.memberId)).size !== rs.length
          )
            fail("invalid_components");
          gross[si] = rs.map((r) =>
            integer(rows.find((x) => x.memberId === r.memberId)?.grossCents),
          );
          if (gross[si].reduce((s, n) => s + n, 0) !== stages[si].grossCents)
            fail("invalid_components");
        }
      }
      const mf =
        recipient === null
          ? rs.map(() => null)
          : largestRemainder(recipient, weights, keys);
      const components = rs.flatMap((r, mi) => {
        const gs = stages.map((_, si) => gross[si][mi]);
        const fs =
          mf[mi] === null
            ? gs.map(() => null)
            : largestRemainder(
                mf[mi],
                gs,
                stages.map(
                  (s) =>
                    String(s.position).padStart(10, "0") + ":" + s.milestoneId,
                ),
              );
        return stages.map((s, si) => {
          if (fs[si] !== null && fs[si] > gs[si]) fail("fee_exceeds_component");
          return {
            memberId: r.memberId,
            milestoneId: s.milestoneId,
            stagePosition: s.position,
            grossCents: gs[si],
            recipientFeeCents: fs[si],
            netCents: fs[si] === null ? null : gs[si] - fs[si],
          };
        });
      });
      return {
        fundingPlanLotId: l.fundingPlanLotId,
        principalCents,
        estimatedProcessorFeeCents: fee,
        publisherProcessorFeeCents: publisher,
        recipientProcessorFeeCents: recipient,
        chargeTotalCents:
          publisher === null ? null : integer(principalCents + publisher),
        components,
      };
    })
    .sort((a, b) => (a.fundingPlanLotId < b.fundingPlanLotId ? -1 : 1));
  integer(planned.reduce((s, l) => s + l.principalCents, 0));
  const plan = {
    calculationVersion: CALCULATION_VERSION,
    currency: "USD",
    platformServiceFeeCents: 0,
    roundingRule: "largest_remainder_uuid_stage;odd_fee_cent_publisher",
    members: rs,
    lots: planned,
  };
  return { ...plan, digest: digest(plan) };
}
