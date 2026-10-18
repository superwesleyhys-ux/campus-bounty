import Stripe from 'stripe';
import {randomBytes} from 'node:crypto';
import {paymentWebhook} from '../../backend/http/payment-webhook.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./payment-money-fixture.mjs";
import { fakeTransport } from "./payment-money-scenarios.mjs";
import { digest } from "../../backend/payments/amounts.mjs";
import { createStripePayments } from "../../backend/adapters/stripe-payments.mjs";
import { createPaymentWorker } from "../../backend/adapters/payment-worker.mjs";
test("persistent bounded recipient polling reaches all 20 ordinary-onboarded accounts including failed retrievals; mock transport", async () => {
  const f = await isolated(0);
  try {
    await f.migrateThrough(20);
    const env = {
      id: key(),
      platformAccountId: "acct_polling",
      mode: "sandbox",
    };
    await f.owner.query(
      "INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B scheduler synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",
      [env.id, env.platformAccountId],
    );
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
    const transport = fakeTransport(),
      worker = createPaymentWorker(
        f.store,
        createStripePayments({ client: transport.client, environment: env }),
      );
    const config = {
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: { stripe_transfers: { requested: true } },
          },
        },
      },
    };
    for (let n = 0; n < 20; n++) {
      const user = await f.user("Recipient " + n);
      await f.owner.query(
        "INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B synthetic recipient configuration')",
        [env.id, user, JSON.stringify(config), digest(config)],
      );
      await f.market.onboardPaymentAccount(
        user,
        { expectedAccountRevision: 0 },
        key(),
      );
      await worker.dispatch();
    }
    const seen = [],
      retrieve = transport.client.v2.core.accounts.retrieve;
    transport.client.v2.core.accounts.retrieve = async (id) => {
      seen.push(id);
      return retrieve(id);
    };
    await worker.refreshRecipients();
    assert.equal(seen.length, 16);
    await worker.refreshRecipients();
    assert.equal(seen.length, 32);
    assert.equal(new Set(seen).size, 20);
    const all = (
      await f.store.workerTx((c) =>
        c.query("SELECT campus.money_account_targets($1) AS result", [env.id]),
      )
    ).rows[0].result;
    assert.equal(
      all.length,
      20,
      "Exact event-account lookup remains independent of bounded polling",
    );
    const failed = new Set(all.slice(0, 16).map((x) => x.accountId));
    seen.length = 0;
    transport.client.v2.core.accounts.retrieve = async (id) => {
      seen.push(id);
      if (failed.has(id)) throw Error("synthetic retrieval failure");
      return retrieve(id);
    };
    await worker.refreshRecipients();
    await worker.refreshRecipients();
    assert.equal(seen.length, 32);
    assert.equal(
      new Set(seen).size,
      20,
      "Failed old accounts do not monopolize future batches",
    );
    // Exact thin notification context and account-link-returned full-event identity.
    const sdk=new Stripe('synthetic-no-network'),secret='whsec_'+randomBytes(24).toString('hex'),events=new Map(),eventCalls=[];
    transport.client.webhooks=sdk.webhooks;transport.client.parseEventNotification=sdk.parseEventNotification.bind(sdk);
    transport.client.v2.core.events={retrieve:async(id,params,opts)=>{eventCalls.push({id,opts});return events.get(id);}};
    transport.client.v2.core.accounts.retrieve=retrieve;
    const thinAdapter=createStripePayments({client:transport.client,environment:env,thinSecret:secret}),thinWorker=createPaymentWorker(f.store,thinAdapter),handler=paymentWebhook(async()=>({paymentAdapter:thinAdapter,store:f.store}),{thin:true});
    for(const type of ['v2.core.account[configuration.recipient].capability_status_updated','v2.core.account_link.returned']){
      const event={id:'evt_'+key(),object:'v2.core.event',type,created:new Date().toISOString(),livemode:false,context:env.platformAccountId,...(type.endsWith('returned')?{}:{related_object:{id:all[19].accountId,type:'v2.core.account',url:'/v2/core/accounts/'+all[19].accountId}})};
      events.set(event.id,{...event,...(type.endsWith('returned')?{data:{account_id:all[19].accountId}}:{})});
      const body=JSON.stringify(event);assert.equal((await handler(new Request('http://127.0.0.1/api/v1/webhooks/stripe-thin',{method:'POST',body,headers:{'stripe-signature':sdk.webhooks.generateTestHeaderString({payload:body,secret})}}))).status,200);await thinWorker.inbox();
      assert.equal((await f.owner.query('SELECT status,last_code FROM campus.provider_inbox WHERE event_id=$1',[event.id])).rows[0].status,'processed');
    }
    assert.equal(eventCalls.length,2);assert.ok(eventCalls.every(c=>c.opts.stripeContext===env.platformAccountId));
  } finally {
    await f.close();
  }
});
