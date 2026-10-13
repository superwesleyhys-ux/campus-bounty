// Compatibility entry point: same protected 012 target and replay semantics.
// The shared engine additionally recognizes only the exact reviewed 013 file.
const engine = require("./conversation-reviewed-upgrade.cjs");
module.exports = {
  upgradeReviewed012: engine.upgradeReviewed012,
  verifyReviewedReplay: engine.verifyReviewedReplay012,
  reviewedPrior: engine.prior011,
  migrationName: engine.migration012Name,
  migrationSha: engine.migration012Sha,
};
