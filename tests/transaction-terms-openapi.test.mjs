import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allocationRevisionSchema } from "../backend/modules/payment-allocations.mjs";
test("generated allocation confirmation revision matches bounded integer route", async () => {
  const spec = JSON.parse(
    await readFile(
      new URL("../docs/backend-openapi.json", import.meta.url),
      "utf8",
    ),
  );
  const op =
    spec.paths["/applications/{id}/allocations/{revision}/confirmations"].post;
  const p = op.parameters.find((p) => p.name === "revision" && p.in === "path");
  assert.equal(p.required, true);
  assert.deepEqual(p.schema, {
    type: "integer",
    minimum: 1,
    maximum: 2147483646,
  });
  for (const n of [1, 2, 2147483646])
    assert.equal(allocationRevisionSchema.parse(String(n)), n);
  for (const bad of [
    "0",
    "-1",
    "1.5",
    "2147483647",
    "not-a-number",
    "00000000-0000-4000-8000-000000000001",
  ])
    assert.equal(allocationRevisionSchema.safeParse(bad).success, false);
  assert.equal(
    spec.components.schemas.AllocationRevision.properties.policy_snapshot
      .anyOf[0].$ref,
    "#/components/schemas/TransactionPolicySnapshot",
  );
});
