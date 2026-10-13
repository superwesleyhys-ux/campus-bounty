// Aggregate-only monitoring for bounded concurrent local browser regressions.
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { withFixture } = require("./team-browser-support.cjs");
const output = process.argv[2];
assert.match(output || "", /^docs\/evidence\/interaction-round6\/[a-z0-9-]+\.json$/);
assert.ok(!fs.existsSync(output), "Preserve prior monitoring evidence");
const stop = ".data/qa/round6/runtime-monitor.stop";
assert.ok(!fs.existsSync(stop), "A previous monitor was already stopped");

(async () => {
  const started = Date.now(), samples = [];
  await withFixture(async (c) => {
    console.log("Aggregate connection monitor ready");
    while (Date.now() - started < 180000 && !fs.existsSync(stop)) {
      const totals = (await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE datname=current_database())::int AS preview FROM pg_stat_activity")).rows[0];
      const pools = (await c.query("SELECT usename,count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('campus_app','campus_auth','campus_worker') GROUP BY usename ORDER BY usename")).rows;
      samples.push({ time: new Date().toISOString(), ...totals, pools });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  const result = { startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), peakTotal: Math.max(...samples.map((r) => r.total)), peakPreview: Math.max(...samples.map((r) => r.preview)), scope: "Read-only aggregate counts during concurrent local browser regression; no production capacity claim.", samples };
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ samples: samples.length, peakTotal: result.peakTotal, peakPreview: result.peakPreview }));
})().catch((error) => { console.error(error.code || error.name); process.exitCode = 1; });
