import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./transaction-ui-fixture.mjs";
import { configure } from "./transaction-ui-setup.mjs";
async function order(f) {
  const m = f.market,
    B = await f.user("Recovery buyer"),
    S = await f.user("Recovery seller");
  const product = await m.publishProduct(
    S,
    {
      title: "Synthetic pickup",
      description: "Reserved stock recovery",
      priceCents: 10000,
      stock: 1,
      deliveryMethods: ["pickup"],
      shippingCents: 0,
    },
    key(),
  );
  const reservation = await m.quoteVersioned(
      B,
      product.id,
      {
        quantity: 1,
        deliveryMethod: "pickup",
        expectedRevision: 1,
        expectedTermsVersion: 1,
      },
      key(),
    ),
    o = await m.order(B, { quoteId: reservation.id }, key());
  await m.preparePaymentTerms(B, "order", o.id, {}, key());
  let v = await m.participantPayment(B, "order", o.id);
  const p = v.orderPolicy;
  for (const who of [B, S])
    await m.confirmOrderPaymentPolicy(
      who,
      o.id,
      {
        expectedPaymentRevision: p.paymentRevision,
        orderTermsDigest: p.orderTermsDigest,
        policyVersionId: p.policyVersionId,
        policyDigest: p.policyDigest,
      },
      key(),
    );
  v = await m.participantPayment(B, "order", o.id);
  const fp = await m.proposePaymentFeePlan(
    B,
    "order",
    o.id,
    {
      policyVersionId: v.feePlan.context.policyId,
      policyDigest: v.feePlan.context.policyDigest,
      sourceDigest: v.feePlan.context.sourceDigest,
    },
    key(),
  );
  for (const who of [B, S])
    await m.confirmPaymentFeePlan(
      who,
      fp.receipt.planId,
      { digest: fp.receipt.digest },
      key(),
    );
  const q = (await m.createOrderPaymentQuote(B, o.id, v.quoteRequest, key()))
    .receipt;
  const a = (
    await m.createPaymentAttempt(
      B,
      q.obligationId,
      {
        quoteId: q.quoteId,
        quoteDigest: q.quoteDigest,
        expectedObligationRevision: q.obligationRevision,
        acceptedAmountCents: q.quote.chargeTotalCents,
        currency: "USD",
      },
      key(),
    )
  ).receipt;
  return { B, S, product, o, q, a };
}
async function cancel(f, s) {
  const d = await f.market.orderPayment(s.B, s.o.id);
  return f.market.cancelPaymentOrder(
    s.B,
    s.o.id,
    {
      orderTermsDigest: d.financialPolicy.orderTermsDigest,
      expectedPaymentRevision: d.paymentRevision,
    },
    key(),
  );
}
test("ordinary goods cancellation releases only confirmed unpaid stock and holds late cash", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f);
    for (const latePaid of [false, true]) {
      const s = await order(f);
      await x.worker.dispatch();
      const a = await f.market.paymentAttempt(s.B, s.a.attemptId);
      assert(a.sessionId);
      await cancel(f, s);
      assert.equal((await f.market.product(s.S, s.product.id)).stock, 0);
      if (latePaid) x.transport.pay(a.sessionId, { fee: 100, available: true });
      for (let i = 0; i < 5; i++) await x.worker.tick();
      const view = await f.market.orderPayment(s.B, s.o.id);
      assert(
        !(
          await f.market.participantPayment(s.B, "order", s.o.id)
        ).funding.allowedActions.includes("request_quote"),
      );
      assert.equal(
        (await f.market.product(s.S, s.product.id)).stock,
        latePaid ? 0 : 1,
      );
      const n = (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.inventory_release_events WHERE order_id=$1",
          [s.o.id],
        )
      ).rows[0].n;
      assert.equal(n, latePaid ? 0 : 1);
      if (latePaid) {
        assert.equal(view.coverage, "held");
        assert.equal(view.receivedCents, "10055");
        assert.equal(x.transport.transfers.size, 0);
      }
      console.log(
        JSON.stringify({
          latePaid,
          orderId: s.o.id,
          view,
          inventoryReleaseCount: n,
        }),
      );
    }
  } finally {
    await f.close();
  }
});
test("unknown Checkout creation keeps original operation and reserved goods stock on cancellation", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f),
      s = await order(f);
    const create = x.transport.client.checkout.sessions.create;
    let calls = 0;
    x.transport.client.checkout.sessions.create = async (...args) => {
      calls++;
      await create(...args);
      throw Error("Synthetic response loss after Checkout creation");
    };
    await x.worker.dispatch();
    const before = await f.market.paymentAttempt(s.B, s.a.attemptId);
    assert.equal(before.status, "unknown");
    await cancel(f, s);
    const after = await f.market.paymentAttempt(s.B, s.a.attemptId);
    assert.equal(after.operationId, before.operationId);
    assert.equal((await f.market.product(s.S, s.product.id)).stock, 0);
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.inventory_release_events WHERE order_id=$1",
          [s.o.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(calls, 1);
    console.log(JSON.stringify({ before, after, stock: 0, creations: calls }));
  } finally {
    await f.close();
  }
});
