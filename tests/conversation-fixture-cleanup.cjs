const assert = require("node:assert/strict");

// One owner tracks partial acquisition; repeated/concurrent teardown shares the
// same result and never issues a second DROP or closes another test's resources.
function createFixtureCleanup(resources) {
  let closing;
  return function close() {
    return (closing ??= (async () => {
      const errors = [];
      const attempt = async (label, action) => {
        try {
          await action();
        } catch (cause) {
          errors.push(new Error(`Fixture cleanup: ${label}`, { cause }));
        }
      };
      if (resources.store)
        await attempt("store.close", () => resources.store.close());
      if (resources.client)
        await attempt("client.end", () => resources.client.end());
      if (resources.created)
        await attempt("drop created database", async () => {
          assert.match(resources.database, /^campus_test_[a-f0-9]{32}$/);
          assert.equal(new URL(resources.adminUrl).hostname, "127.0.0.1");
          assert.ok(
            resources.admin,
            "Created database must have its owning admin",
          );
          await resources.admin.query(
            `DROP DATABASE ${resources.database} WITH (FORCE)`,
          );
        });
      if (resources.admin)
        await attempt("admin.end", () => resources.admin.end());
      if (errors.length)
        throw new AggregateError(errors, "Disposable fixture cleanup failed");
    })());
  };
}

async function cleanupSetupFailure(error, close) {
  try {
    await close();
  } catch (cleanupError) {
    // The acquisition error stays the primary cause; retain every cleanup
    // diagnostic as well, rather than replacing it with the first close error.
    throw new AggregateError(
      [error, cleanupError],
      "Fixture setup failed and cleanup reported errors",
      { cause: error },
    );
  }
  throw error;
}
module.exports = { createFixtureCleanup, cleanupSetupFailure };
