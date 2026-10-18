import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { paymentWebhook } from "../../backend/http/payment-webhook.mjs";
import { reconcilePayment } from "../../backend/payments/reconciliation.mjs";
import { ratios, componentPlan } from "../../backend/payments/amounts.mjs";
test("original signed bounded bytes, wrong signature/mode, unavailable durable persistence; test signatures only", async () => {
  const sdk = new Stripe("synthetic-no-network");
  const secret = "whsec_" + randomBytes(24).toString("hex");
  const environment = {
    id: "00000000-0000-4000-8000-000000000001",
    platformAccountId: "acct_synthetic",
    mode: "sandbox",
  };
  const adapter = createStripePayments({
    client: sdk,
    environment,
    snapshotSecret: secret,
  });
  const calls = [];
  let unavailable = false;
  const runtime = {
    paymentAdapter: adapter,
    store: {
      workerTx: async (fn) => {
        if (unavailable) throw Error("database unavailable");
        return fn({
          query: async (sql, args) => {
            calls.push(args);
            return { rows: [] };
          },
        });
      },
    },
  };
  const handler = paymentWebhook(async () => runtime);
  assert.equal(
    (
      await paymentWebhook(async () => {
        throw Error("runtime unavailable");
      })(new Request("http://127.0.0.1", { method: "POST" }))
    ).status,
    503,
  );
  const body = JSON.stringify({
    id: "evt_synthetic",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: "cs_synthetic" } },
  });
  const signed = sdk.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
  const request = (bytes = body, sig = signed) =>
    new Request("http://127.0.0.1/api/v1/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sig },
      body: bytes,
    });
  assert.equal((await handler(request(body, "invalid"))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request())).status, 200);
  assert.equal(calls.length, 1);
  unavailable = true;
  assert.equal((await handler(request())).status, 503);
  assert.equal((await handler(request("x".repeat(262145)))).status, 413);
  const live = body.replace("false", "true");
  assert.equal(
    (
      await handler(
        request(
          live,
          sdk.webhooks.generateTestHeaderString({ payload: live, secret }),
        ),
      )
    ).status,
    400,
  );
});
test("zero share is rejected; legitimate zero rounded gross survives", () => {
  const A = "00000000-0000-4000-8000-000000000001",
    B = "00000000-0000-4000-8000-000000000002";
  assert.throws(() =>
    ratios([
      { memberId: A, units: 10000 },
      { memberId: B, units: 0 },
    ]),
  );
  const p = componentPlan({
    members: [
      { memberId: A, units: 5000 },
      { memberId: B, units: 5000 },
    ],
    lots: [
      {
        fundingPlanLotId: "tiny",
        estimatedProcessorFeeCents: 0,
        stages: [{ position: 1, milestoneId: "s1", grossCents: 1 }],
      },
    ],
  });
  assert.equal(p.lots[0].components[1].grossCents, 0);
});
