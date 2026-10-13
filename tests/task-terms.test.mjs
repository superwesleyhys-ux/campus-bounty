import test from "node:test";
import assert from "node:assert/strict";
import {
  isCalendarDate,
  formatDueDate,
  validateTaskTerms,
} from "../src/lib/task-terms.mjs";

test("delivery dates preserve calendar meaning and reject impossible dates", () => {
  for (const value of ["2028-02-29", "2026-10-12", "9999-12-31"])
    assert.equal(isCalendarDate(value), true);
  for (const value of [
    null,
    undefined,
    "",
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-10-12T00:00:00Z",
    "10/12/2026",
    "0000-01-01",
  ])
    assert.equal(isCalendarDate(value), false, String(value));
  const previous = process.env.TZ;
  try {
    for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(formatDueDate("2026-10-12"), "October 12, 2026");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  assert.equal(formatDueDate(null), "Not specified");
  assert.equal(formatDueDate("2026-02-30"), "Not specified");
});

test("new publishing requires explicit criteria without inventing terms for a legacy draft", () => {
  assert.throws(
    () => validateTaskTerms("", [{ acceptanceCriteria: "Review the report" }]),
    /delivery date/,
  );
  assert.throws(
    () => validateTaskTerms("2026-12-01", [{ deliverable: "Report" }]),
    /milestone 1/,
  );
  assert.throws(
    () =>
      validateTaskTerms("2026-12-01", [
        { acceptanceCriteria: "Complete" },
        { acceptanceCriteria: " \n " },
      ]),
    /milestone 2/,
  );
  assert.throws(
    () =>
      validateTaskTerms("2026-12-01", [
        { acceptanceCriteria: "x".repeat(10001) },
      ]),
    /10,000/,
  );
  assert.doesNotThrow(() =>
    validateTaskTerms("2026-12-01", [
      { acceptanceCriteria: "Include source data.\nExplain missing values." },
    ]),
  );
});
