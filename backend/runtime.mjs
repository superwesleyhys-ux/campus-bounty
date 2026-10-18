import { paymentConfig } from "./payments/config.mjs";
import { createStripePayments } from "./adapters/stripe-payments.mjs";
import { createHash } from "node:crypto";
import { readConfig } from "./config.mjs";
import { createStore } from "./db/store.mjs";
import { createAuth } from "./modules/auth.mjs";
import { createMarket } from "./modules/market.mjs";
const sharedStoreKey = Symbol.for("campus.backend.shared-store.v1");
// Next route modules and HMR can instantiate this module more than once. Share
// only connection pools, so each runtime still builds the current business code.
export function processSharedStore(urls) {
  const signature = createHash("sha256")
    .update(JSON.stringify([urls.app, urls.auth, urls.worker]))
    .digest("hex");
  const existing = globalThis[sharedStoreKey];
  if (existing) {
    if (existing.signature !== signature)
      throw new Error(
        "Database configuration changed; restart the server before serving requests.",
      );
    return existing.store;
  }
  const store = createStore(urls);
  globalThis[sharedStoreKey] = { signature, store };
  return store;
}
export async function createRuntime(env = process.env, { sharedStore } = {}) {
  const config = readConfig(env),
    store = sharedStore ?? createStore(config.urls);
  try {
    await store.verifyRoles();
    const payments = paymentConfig(env);
    if (payments.enabled) {
      const binding = (
        await store.worker.query(
          "SELECT campus.money_environment_binding($1) AS result",
          [payments.environment.id],
        )
      ).rows[0]?.result;
      if (
        !binding?.enabled ||
        binding.platformAccountId !== payments.environment.platformAccountId ||
        binding.mode !== payments.environment.mode
      )
        throw Error("Payment environment mismatch");
    }
    if (config.production) {
      const count = (
        await store.auth.query(
          "SELECT count(*) FROM campus.domains d JOIN campus.institutions i ON i.id=d.institution_id WHERE d.enabled AND i.active AND d.domain NOT LIKE '%.test'",
        )
      ).rows[0].count;
      if (Number(count) === 0)
        throw Error("No reviewed campus domains are enabled");
    }
    return {
      config,
      store,
      paymentAdapter: payments.enabled ? createStripePayments(payments) : null,
      auth: createAuth(store, config),
      market: createMarket(store, {
        production: config.production,
        paymentEnabled: payments.enabled,
      }),
    };
  } catch (e) {
    // A failing route must never close pools that other routes are using.
    if (!sharedStore) await store.close();
    throw e;
  }
}
