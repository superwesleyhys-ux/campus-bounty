// Root-reviewed, single012 upgrade of the EXISTING loopback disposable preview.
// Never restart the preview. Every preservation check happens before COMMIT.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { withFixture } = require("./team-browser-support.cjs");
const {
  upgradeReviewed012,
  verifyReviewedReplay,
} = require("./conversation-upgrade-harness.cjs");

(async () => {
  const expectedHash = process.env.EXPECTED_CONVERSATION_SHA;
  const migration = process.env.CONVERSATION_MIGRATION;
  assert.match(expectedHash || "", /^[a-f0-9]{64}$/);
  assert.equal(migration, "012_conversation_history_context.sql");
  const folder = path.resolve(
    "docs/evidence/interaction-round8/upgrade-harness",
    `preview-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  fs.mkdirSync(folder, { recursive: true });
  let committed = false;
  try {
    const result = await withFixture(async (client) => {
      const outcome = await upgradeReviewed012(client, {
        expectedHash,
        migration,
        evidenceDirectory: folder,
      });
      committed = outcome.transactionOutcome === "committed";
      const replayApplied = await verifyReviewedReplay(client, {
        expectedHash,
        migration,
      });
      assert.equal(replayApplied, 0);
      return {
        transactionOutcome: outcome.transactionOutcome,
        migration,
        sha256: expectedHash,
        applied: outcome.applied,
        replayApplied,
        exactContexts: outcome.exactContexts,
        oldTableCount: outcome.tables.length,
        evidenceDirectory: folder,
        scope:
          "Existing loopback disposable fixture only; no production, payment or mail proof.",
      };
    });
    fs.writeFileSync(
      path.join(folder, "preview-upgrade.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {
      transactionOutcome:
        error.upgradeOutcome?.transactionOutcome ||
        (committed ? "committed" : "not_started"),
      stage: committed ? "post_commit_replay_or_receipt" : "upgrade",
      error: {
        name: error.name,
        code: error.code || null,
        message: error.message,
      },
      evidenceDirectory: folder,
    };
    fs.writeFileSync(
      path.join(folder, "preview-upgrade-failure.json"),
      JSON.stringify(failure, null, 2) + "\n",
      { flag: "wx" },
    );
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
