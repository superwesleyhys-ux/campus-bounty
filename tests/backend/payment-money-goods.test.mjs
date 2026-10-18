import Stripe from 'stripe';
import {randomBytes} from 'node:crypto';
import {paymentWebhook} from '../../backend/http/payment-webhook.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {
  isolated,
  key,
  syntheticPolicyPayload,
} from "./payment-money-fixture.mjs";
import { fakeTransport } from "./payment-money-scenarios.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
import { createPosting } from "../../backend/payments/posting.mjs";
test("actual goods policy consent and cancellation retain inventory until verified terminal; late paid fact held; mock transport only", async () => {
  const f = await isolated(1);
  try {
    await f.migrateThrough(20);
    const m = f.market,
      B = await f.user("Buyer"),
      S = await f.user("Seller");
    const env = {
      id: key(),
      platformAccountId: "acct_goodsmock",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B goods synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const product = await m.publishProduct(
      S,
      {
        title: "Synthetic physical item",
        description: "Pickup item",
        priceCents: 10000,
        stock: 2,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      key(),
    );
    const quote = await m.quoteVersioned(
      B,
      product.id,
      {
        quantity: 1,
        deliveryMethod: "pickup",
        expectedRevision: 1,
        expectedTermsVersion: 1,
      },
      key(),
    );
    const order = await m.order(B, { quoteId: quote.id }, key());
    let projection = await m.orderPayment(B, order.id);
    assert.ok(
      projection.blockedReasons.includes("financial_policy_unresolved"),
    );
    assert.ok(!projection.allowedActions.includes("request_quote"));
    const d = projection.financialPolicy.orderTermsDigest;
    const payload = {
      ...syntheticPolicyPayload(301, 10000),
      orderTermsDigest: d,
      feeAdjustment: "hold_on_variance",
      goodsRelease: "pending_decision",
    };
    const pid = key();
    await f.owner.query(
      "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'order',$3,'collection',1,'approved',$4,$5,'Task2B synthetic goods')",
      [pid, env.id, order.id, JSON.stringify(payload), digest(payload)],
    );
    for (const actor of [B, S])
      assert.ok(
        (await m.orderPayment(actor, order.id)).allowedActions.includes(
          "confirm_payment_policy",
        ),
      );
    const consent = {
      expectedPaymentRevision: 0,
      orderTermsDigest: d,
      policyVersionId: pid,
      policyDigest: digest(payload),
    };
    const foreignEnvironment = key(),
      foreignPolicy = key(),
      wrongPurpose = key();
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox','acct_foreignfixture','Task2B disabled foreign environment','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',false)",
      [foreignEnvironment],
    );
    for (const [id, environment, purpose] of [
      [foreignPolicy, foreignEnvironment, "collection"],
      [wrongPurpose, env.id, "release"],
    ])
      await f.owner.query(
        "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'order',$3,$4,1,'approved',$5,$6,'Task2B synthetic wrong scope')",
        [
          id,
          environment,
          order.id,
          purpose,
          JSON.stringify(payload),
          digest(payload),
        ],
      );
    for (const id of [foreignPolicy, wrongPurpose])
      await assert.rejects(
        m.confirmOrderPaymentPolicy(
          B,
          order.id,
          { ...consent, policyVersionId: id },
          key(),
        ),
        (e) => e.code === "not_found",
      );
    await m.confirmOrderPaymentPolicy(B, order.id, consent, key());
    await assert.rejects(
      m.createOrderPaymentQuote(
        B,
        order.id,
        { orderTermsDigest: d, expectedPaymentRevision: 0 },
        key(),
      ),
      (e) => e.code === "financial_consent_required",
    );
    assert.ok(
      !(await m.orderPayment(B, order.id)).allowedActions.includes(
        "request_quote",
      ),
    );
    await m.confirmOrderPaymentPolicy(S, order.id, consent, key());
    assert.ok(
      (await m.orderPayment(B, order.id)).allowedActions.includes(
        "request_quote",
      ),
    );
    assert.ok(
      !(await m.orderPayment(S, order.id)).allowedActions.includes(
        "request_quote",
      ),
    );
    const q = (
      await m.createOrderPaymentQuote(
        B,
        order.id,
        { orderTermsDigest: d, expectedPaymentRevision: 0 },
        key(),
      )
    ).receipt;
    const attempt = (
      await m.createPaymentAttempt(
        B,
        q.obligationId,
        {
          quoteId: q.quoteId,
          quoteDigest: q.quoteDigest,
          expectedObligationRevision: 1,
          acceptedAmountCents: 10151,
          currency: "USD",
        },
        key(),
      )
    ).receipt;
    // A newly approved exact policy cannot silently reuse the old obligation/quote.
    const revisedPayload = {
      ...payload,
      policyText: "Revised synthetic disclosure; fresh consent required",
    };
    const revisedPolicy = key();
    await f.owner.query(
      "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'order',$3,'collection',2,'approved',$4,$5,'Task2B synthetic policy revision')",
      [
        revisedPolicy,
        env.id,
        order.id,
        JSON.stringify(revisedPayload),
        digest(revisedPayload),
      ],
    );
    for (const actor of [B, S])
      await m.confirmOrderPaymentPolicy(
        actor,
        order.id,
        {
          ...consent,
          expectedPaymentRevision: 1,
          policyVersionId: revisedPolicy,
          policyDigest: digest(revisedPayload),
        },
        key(),
      );
    await assert.rejects(
      m.createOrderPaymentQuote(
        B,
        order.id,
        { orderTermsDigest: d, expectedPaymentRevision: 1 },
        key(),
      ),
      (e) => e.code === "quote_changed",
    );
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.funding_obligations WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      1,
    );
    const transport = fakeTransport(),
      adapter = createStripePayments({
        client: transport.client,
        environment: env,
      }),
      worker = createPaymentWorker(f.store, adapter);
    await worker.dispatch();
    const a = await m.paymentAttempt(B, attempt.attemptId);
    await m.cancelPaymentOrder(
      B,
      order.id,
      { orderTermsDigest: d, expectedPaymentRevision: 1 },
      key(),
    );
    assert.equal((await m.product(S, product.id)).stock, 1);
    assert.equal((await m.getOrder(B, order.id)).state, "pending_payment");
    // The remote session expired before our expire request. Its strict fake
    // throws on expire; the actual worker must still retrieve exact terminal state.
    transport.sessions.get(a.sessionId).status='expired';
    await worker.dispatch();
    assert.equal((await m.getOrder(B, order.id)).state, "cancelled");
    assert.equal((await m.product(S, product.id)).stock, 2);
    await m.cancelOrder(B, order.id, {}, key()).catch(() => {});
    assert.equal((await m.product(S, product.id)).stock, 2);
    // A contradictory late provider success is still a financial fact, never resurrection/restock twice.
    transport.pay(a.sessionId, { fee: null });
    const expected = (
      await f.store.workerTx((c) =>
        c.query("SELECT campus.money_find_attempt($1,$2) AS result", [
          env.id,
          a.sessionId,
        ]),
      )
    ).rows[0].result;
    await createPosting(f.store).payment(
      expected,
      await adapter.retrieveCheckoutAndPayment(a.sessionId),
    );
    transport.setFee(a.sessionId, 301);
    await createPosting(f.store).payment(
      expected,
      await adapter.retrieveCheckoutAndPayment(a.sessionId),
    );
    const changed = await adapter.retrieveCheckoutAndPayment(a.sessionId),
      newBalanceId = "txn_" + key();
    changed.charge.balance_transaction = newBalanceId;
    transport.balances.set(newBalanceId, {
      ...changed.balance,
      id: newBalanceId,
    });
    for (let i = 0; i < 2; i++)
      await createPosting(f.store).payment(
        expected,
        await adapter.retrieveCheckoutAndPayment(a.sessionId),
      );
    transport.setFee(a.sessionId, 501);
    for (let i = 0; i < 2; i++)
      await createPosting(f.store).payment(
        expected,
        await adapter.retrieveCheckoutAndPayment(a.sessionId),
      );
    const cash = (
      await f.owner.query(
        "SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",
        [env.id],
      )
    ).rows[0].n;
    assert.equal(cash, "9850");
    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int n FROM campus.payment_receipt_facts WHERE disposition='fee_conflict'",
        )
      ).rows[0].n,
      2,
    );
    assert.equal((await m.getOrder(B, order.id)).state, "cancelled");
    assert.equal((await m.product(S, product.id)).stock, 2);
    assert.equal((await m.orderPayment(B, order.id)).coverage, "held");
    // Signed external facts against a late receipt that has no funding allocation.
    const sdk=new Stripe('synthetic-no-network'),secret='whsec_'+randomBytes(24).toString('hex');transport.client.webhooks=sdk.webhooks;
    const ingress=createStripePayments({client:transport.client,environment:env,snapshotSecret:secret});
    const handler=paymentWebhook(async()=>({paymentAdapter:ingress,store:f.store}));
    const charge=(await adapter.retrieveCheckoutAndPayment(a.sessionId)).charge;
    const refund=await transport.client.refunds.create({charge:charge.id,amount:1000,metadata:{}},{idempotencyKey:'external-late-'+key()});
    const dispute={id:'dp_'+key(),charge:charge.id,livemode:false,balance_transactions:[]};
    const db={id:'txn_'+key(),source:dispute.id,amount:-500,net:-500,fee:0,currency:'usd',status:'available'};
    transport.balances.set(db.id,db);dispute.balance_transactions.push(db);transport.client.disputes={retrieve:async()=>dispute};
    for(const [type,id] of [['refund.updated',refund.id],['charge.dispute.funds_withdrawn',dispute.id]])for(let n=0;n<2;n++){
      const body=JSON.stringify({id:'evt_'+key(),type,livemode:false,data:{object:{id}}});
      assert.equal((await handler(new Request('http://127.0.0.1/api/v1/webhooks/stripe',{method:'POST',body,headers:{'stripe-signature':sdk.webhooks.generateTestHeaderString({payload:body,secret})}}))).status,200);await worker.inbox();
    }
    assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,0);
    assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_external_balance_facts WHERE receipt_fact_id IS NOT NULL')).rows[0].n,1);
    assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_network_balance_facts WHERE receipt_fact_id IS NOT NULL')).rows[0].n,1);
    assert.equal((await f.owner.query("SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",[env.id])).rows[0].n,'8350');
    assert.equal((await m.getOrder(B,order.id)).state,'cancelled');assert.equal((await m.product(S,product.id)).stock,2);

    assert.equal(
      (
        await f.owner.query(
          "SELECT count(*)::int AS n FROM campus.inventory_release_events WHERE order_id=$1",
          [order.id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("approved synthetic buyer receipt earns seller only after actual fee and preserves exact goods component; mock", async () => {
  const f = await isolated(1);
  try {
    await f.migrateThrough(20);
    const m = f.market,
      B = await f.user("Receipt buyer"),
      S = await f.user("Receipt seller"),
      env = {
        id: key(),
        platformAccountId: "acct_goodsreceipt",
        mode: "sandbox",
      };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B receipt synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const product = await m.publishProduct(
      S,
      {
        title: "Synthetic receipt item",
        description: "Physical pickup",
        priceCents: 10000,
        stock: 1,
        deliveryMethods: ["pickup"],
        shippingCents: 0,
      },
      key(),
    );
    const quote = await m.quoteVersioned(
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
      order = await m.order(B, { quoteId: quote.id }, key());
    const d = (await m.orderPayment(B, order.id)).financialPolicy
        .orderTermsDigest,
      pid = key(),
      payload = {
        ...syntheticPolicyPayload(301, 10000),
        orderTermsDigest: d,
        feeAdjustment: "hold_on_variance",
        goodsRelease: "buyer_confirmed_receipt",
      };
    await f.owner.query(
      "INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'order',$3,'collection',1,'approved',$4,$5,'Task2B synthetic buyer receipt release')",
      [pid, env.id, order.id, JSON.stringify(payload), digest(payload)],
    );
    for (const actor of [B, S])
      await m.confirmOrderPaymentPolicy(
        actor,
        order.id,
        {
          expectedPaymentRevision: 0,
          orderTermsDigest: d,
          policyVersionId: pid,
          policyDigest: digest(payload),
        },
        key(),
      );
    const q = (
      await m.createOrderPaymentQuote(
        B,
        order.id,
        { orderTermsDigest: d, expectedPaymentRevision: 0 },
        key(),
      )
    ).receipt;
    const a = (
      await m.createPaymentAttempt(
        B,
        q.obligationId,
        {
          quoteId: q.quoteId,
          quoteDigest: q.quoteDigest,
          expectedObligationRevision: 1,
          acceptedAmountCents: 10151,
          currency: "USD",
        },
        key(),
      )
    ).receipt;
    const t = fakeTransport(),
      adapter = createStripePayments({ client: t.client, environment: env }),
      worker = createPaymentWorker(f.store, adapter),
      post = createPosting(f.store);
    await worker.dispatch();
    const sid = (await m.paymentAttempt(B, a.attemptId)).sessionId,
      expected = (
        await f.store.workerTx((c) =>
          c.query("SELECT campus.money_find_attempt($1,$2) result", [
            env.id,
            sid,
          ]),
        )
      ).rows[0].result;
    t.pay(sid, { fee: null });
    await post.payment(expected, await adapter.retrieveCheckoutAndPayment(sid));
    const config = {
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: { stripe_transfers: { requested: true } },
          },
        },
      },
    };
    await f.owner.query(
      "INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B synthetic seller recipient')",
      [env.id, S, JSON.stringify(config), digest(config)],
    );
    await m.onboardPaymentAccount(S, { expectedAccountRevision: 0 }, key());
    await worker.dispatch();
    await worker.refreshRecipients();
    await m.fulfillOrder(S, order.id, {}, key());
    await m.completeOrder(B, order.id, {}, key());
    await worker.tick();
    assert.equal(t.transfers.size, 0);
    assert.equal(
      (await m.orderPayment(B, order.id)).feeState,
      "fee_actual_pending",
    );
    t.setFee(sid, 301);
    await post.payment(expected, await adapter.retrieveCheckoutAndPayment(sid));
    await worker.tick();
    await worker.tick();
    assert.equal(t.transfers.size, 1);
    assert.equal([...t.transfers.values()][0].amount, 9850);
    assert.equal((await m.getOrder(B, order.id)).state, "completed");
    const read = await m.orderPayment(B, order.id);
    assert.equal(read.transferredCents, "9850");
    assert.equal(read.payees[0].grossSatisfiedCents, "10000");
    assert.equal(read.payees[0].memberId, S);
    assert.equal(read.payees[0].bankPayout, "unknown");
    assert.equal(read.payees[0].releaseState, "transferred");
    const outsider = await f.user("Outsider");
    await assert.rejects(
      m.orderPayment(outsider, order.id),
      (e) => e.code === "not_found",
    );
    await assert.rejects(
      m.paymentAttempt(outsider, a.attemptId),
      (e) => e.code === "not_found",
    );
  } finally {
    await f.close();
  }
});
