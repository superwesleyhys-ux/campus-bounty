import {
  key,
  syntheticPolicyPayload,
  legacyInlineProfile,
} from "./transaction-ui-fixture.mjs";
import { fakeTransport } from "./payment-money-scenarios.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
export async function configure(f, { fixedCents = 100 } = {}) {
  await f.owner.query(
    "UPDATE campus.agreement_amendment_settings SET mutations_enabled=true,strict_binding=true WHERE singleton",
  );
  const env = {
    id: key(),
    platformAccountId: "acct_task2csynthetic",
    mode: "sandbox",
  };
  await f.owner.query(
    "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2C synthetic only','2026-09-30.endive','23.0.0','http://127.0.0.1:3024',true)",
    [env.id, env.platformAccountId],
  );
  await legacyInlineProfile(f, env.id);
  const body = {
    kind: "synthetic_usd_card_minimum_v1",
    presentmentCurrency: "USD",
    settlementCurrency: "USD",
    paymentMethodTypes: ["card"],
    minimumChargeCents: 50,
    source:
      "https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts",
    accountEvidenceDigest: digest({ synthetic: env.id }),
    accountEvidenceRef: "Synthetic: local UI engineering only",
  };
  const cp = key();
  await f.owner.query(
    "INSERT INTO campus.payment_collection_profiles VALUES($1,$2,$3,1,$4,$5,'Synthetic: local UI card support')",
    [cp, env.id, env.platformAccountId, body, digest(body)],
  );
  const bp = (
    await f.owner.query(
      "SELECT id FROM campus.payment_billing_profiles WHERE environment_id=$1",
      [env.id],
    )
  ).rows[0].id;
  const policyTemplate = {
    ...syntheticPolicyPayload(fixedCents, 10000),
    feeAdjustment: "capped_actual_v1",
  };
  policyTemplate.disclosure.feeAdjustment.description = `Synthetic engineering scenario: total processing fee estimate uses the explicitly configured flat ${fixedCents} cents. The additional cap is 10% rounded up, limited to 100 cents. Fees split 50/50; unused payer reserve is owed back to its source charge. Above-cap fees require new personal consent. No real pricing is approved.`;
  const config = {
    kind: "synthetic_product_v1",
    enabled: true,
    evidenceRef: "Synthetic: Task2C local setup",
    evidenceDigest: digest({ synthetic: "Task2C" }),
    collectionProfileId: cp,
    collectionProfileDigest: digest(body),
    billingProfileId: bp,
    feeEstimate: {
      kind: "approved_linear_ceiling_v1",
      rateBps: 0,
      fixedCents,
      minimumAmountCents: 0,
      maximumAmountCents: 100000000,
    },
    policyTemplate,
    recipientIdentityMode: "hosted_collection_only",
    recipientTemplate: {
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: { stripe_transfers: { requested: true } },
          },
        },
      },
    },
  };
  const cfg = key();
  await f.owner.query(
    "INSERT INTO campus.payment_product_configurations VALUES($1,$2,1,$3,$4,'Synthetic: Task2C setup-only flat fee; no real tax or identity determination')",
    [cfg, env.id, config, digest(config)],
  );
  const transport = fakeTransport(),
    adapter = createStripePayments({
      client: transport.client,
      environment: env,
    }),
    worker = createPaymentWorker(f.store, adapter);
  return { env, config, cfg, transport, adapter, worker };
}
