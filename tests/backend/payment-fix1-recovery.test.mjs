import test from 'node:test';
import assert from 'node:assert/strict';
import {isolated,controlledMoneyClock,key} from './payment-money-fixture.mjs';
import {paymentFixture} from './payment-fix1-fixture.mjs';
import {createMarket} from '../../backend/modules/market.mjs';
test('fix1 controlled clock: delayed frozen checkout, processing and fee/availability recover without events; disable matrix and work hold',async()=>{
 const f=await isolated(2);
 try {
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({fee:300,stages:[5000,5000]});
  const frozen=(await f.owner.query('SELECT provider_key,payload,payload_hash FROM campus.money_operations WHERE id=$1',[s.a.operationId])).rows[0];
  await clock.advance(120000);await x.worker.dispatch();const ex=await x.expected(s);
  assert.ok(ex.sessionId);assert.equal(x.transport.calls[0].p.expires_at,undefined);
  assert.deepEqual((await f.owner.query('SELECT provider_key,payload,payload_hash FROM campus.money_operations WHERE id=$1',[s.a.operationId])).rows[0],frozen);
  const session=x.transport.sessions.get(ex.sessionId);session.status='complete';
  await x.worker.tick();assert.equal((await f.market.paymentAttempt(s.P,s.a.attemptId)).status,'processing');assert.equal((await f.market.paymentAttempt(s.P,s.a.attemptId)).hostedUrl,null);
  assert.ok(!(await f.market.agreementFunding(s.P,s.g.id)).allowedActions.includes('open_checkout'));
  x.transport.pay(ex.sessionId,{fee:null});await clock.advance(61000);await x.worker.tick();
  assert.equal((await f.market.agreementFunding(s.P,s.g.id)).feeState,'fee_actual_pending');
  x.transport.setFee(ex.sessionId,300);const objects=await x.adapter.retrieveCheckoutAndPayment(ex.sessionId);objects.balance.status='pending';await clock.advance(121000);await x.worker.tick();
  assert.equal((await f.owner.query('SELECT available_cents FROM campus.funding_allocations WHERE attempt_id=$1',[s.a.attemptId])).rows[0].available_cents,null);
  objects.balance.status='available';await clock.advance(181000);await x.worker.tick();
  assert.equal((await f.market.agreementFunding(s.P,s.g.id)).feeState,'matched');
  assert.equal((await f.owner.query('SELECT available_cents FROM campus.funding_allocations WHERE attempt_id=$1',[s.a.attemptId])).rows[0].available_cents,'9850');
  assert.equal((await f.owner.query("SELECT status FROM campus.payment_reconciliation_jobs WHERE kind='attempt'")).rows[0].status,'done');
  await x.onboard(s.C);await x.accept(s,0);await x.worker.tick();assert.equal(x.transport.transfers.size,1);assert.equal([...x.transport.transfers.values()][0].amount,4925);
  assert.equal((await f.market.agreementFunding(s.P,s.g.id)).transferredCents,'4925','per milestone pays first only');
  const disabled=createMarket(f.store,{paymentEnabled:false});
  await assert.rejects(disabled.createAgreementPaymentQuote(s.P,s.g.id,s.quoteRequest,key()),{code:'payments_unavailable'});
  await assert.rejects(async()=>disabled.createPaymentAttempt(s.P,s.q.obligationId,s.attemptRequest,key()),{code:'payments_unavailable'});
  await assert.rejects(async()=>disabled.onboardPaymentAccount(s.C,{expectedAccountRevision:1},key()),{code:'payments_unavailable'});
  let read=await disabled.agreementFunding(s.P,s.g.id);assert.ok(read.allowedActions.includes('open_dispute'));
  await disabled.openPaymentDispute(s.P,'agreement',s.g.id,{expectedPaymentRevision:read.paymentRevision,reason:'Participant reporting dispute while side effects disabled'},key());
  read=await disabled.agreementFunding(s.P,s.g.id);assert.ok(read.allowedActions.includes('request_refund_review'));
  await disabled.requestPaymentRefund(s.P,'agreement',s.g.id,{obligationId:s.q.obligationId,chargeId:objects.charge.id,expectedPaymentRevision:read.paymentRevision,amountCents:1,reason:'Synthetic review remains available while new side effects disabled',policyVersionId:s.q.quote.policyId},key());
  const gd=await f.market.agreement(s.C,s.g.id),m=gd.milestones[1];
  await assert.rejects(f.market.submitMilestone(s.C,m.id,{expectedVersion:m.version,expectedRevision:m.revision,content:'Must not submit under risk hold',expectedEffectiveTermsId:s.b.terms_id,expectedEffectiveRevision:s.b.terms_revision},key()),{code:'funds_held'});
  const pending=await x.prepare({fee:300});await f.owner.query('UPDATE campus.payment_environments SET enabled=false WHERE id=$1',[x.env.id]);const calls=x.transport.calls.length;await x.worker.dispatch();assert.equal(x.transport.calls.length,calls);
  assert.equal((await f.market.paymentAttempt(pending.P,pending.a.attemptId)).status,'creating');
  x.transport.balances.set('txn_disabled_incoming',{id:'txn_disabled_incoming',type:'stripe_fee',currency:'usd',amount:-1,fee:0,net:-1,status:'available'});await clock.advance(61000);await x.worker.fees();assert.equal((await f.owner.query("SELECT count(*)::int n FROM campus.payment_fee_cash_facts WHERE balance_id='txn_disabled_incoming'")).rows[0].n,1,'authenticated factual reads remain active while new dispatch is disabled');
 }finally{await f.close();}
});
test('fix1 onboarding generations and definitive no effect remain scoped; abandoned lease, retention and retry limits use controlled clock',async()=>{
 const f=await isolated(2);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare();await x.worker.dispatch();
  await x.onboard(s.C);const account=await f.market.paymentAccount(s.C),k=key();const first=await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:account.revision},k);await x.worker.dispatch();
  const firstLink=await f.market.moneyOperation(s.C,first.receipt.operationId);assert.ok(firstLink.hostedUrl);await assert.rejects(f.market.moneyOperation(s.P,first.receipt.operationId),{code:'not_found'});
  assert.equal((await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:account.revision},k)).receipt.operationId,first.receipt.operationId);
  await clock.advance(301000);assert.equal((await f.market.moneyOperation(s.C,first.receipt.operationId)).hostedUrl,null);
  const second=await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:account.revision},key());assert.notEqual(second.receipt.operationId,first.receipt.operationId);await x.worker.dispatch();assert.notEqual((await f.market.moneyOperation(s.C,second.receipt.operationId)).hostedUrl,firstLink.hostedUrl);
  const third=await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:account.revision},key());await x.worker.dispatch();assert.notEqual(third.receipt.operationId,second.receipt.operationId,'replacement after used link does not need capability change');
  const rejected=await x.prepare();const original=x.transport.client.checkout.sessions.create;x.transport.client.checkout.sessions.create=async()=>{throw Object.assign(Error('invalid_parameter'),{type:'StripeInvalidRequestError',statusCode:400,code:'parameter_missing'});};await x.worker.dispatch();assert.equal((await f.market.paymentAttempt(rejected.P,rejected.a.attemptId)).status,'failed');x.transport.client.checkout.sessions.create=original;
  const abandoned=await x.prepare();const claim=await x.sql('SELECT campus.money_claim($1) AS result',[x.env.id]);assert.equal(claim.id,abandoned.a.operationId);await clock.advance(31000);await x.worker.dispatch();assert.ok((await f.market.paymentAttempt(abandoned.P,abandoned.a.attemptId)).sessionId);assert.equal(await x.sql('SELECT campus.money_operation_result($1,$2,$3) AS result',[claim.id,claim.fence,JSON.stringify({status:'unknown'})]),false,'stale lease cannot replace recovered success');
  const unknown=await x.prepare();x.transport.client.checkout.sessions.create=async(p,o)=>{await original(p,o);throw Error('lost_response');};await x.worker.dispatch();const before=(await f.owner.query('SELECT provider_key,payload,payload_hash FROM campus.money_operations WHERE id=$1',[unknown.a.operationId])).rows[0];await clock.advance(24*3600000);const count=x.transport.calls.length;await x.worker.dispatch();assert.equal(x.transport.calls.length,count);assert.equal((await f.owner.query('SELECT last_code FROM campus.payment_outbox WHERE operation_id=$1',[unknown.a.operationId])).rows[0].last_code,'provider_retention_elapsed');assert.deepEqual((await f.owner.query('SELECT provider_key,payload,payload_hash FROM campus.money_operations WHERE id=$1',[unknown.a.operationId])).rows[0],before);
  const exhausted=await x.prepare();for(let i=0;i<8;i++){await x.worker.dispatch();await clock.advance(300000);}assert.equal((await f.owner.query('SELECT attempts,dead_letter FROM campus.payment_outbox WHERE operation_id=$1',[exhausted.a.operationId])).rows[0].attempts,8);assert.equal((await f.owner.query('SELECT dead_letter FROM campus.payment_outbox WHERE operation_id=$1',[exhausted.a.operationId])).rows[0].dead_letter,true);
 }finally{await f.close();}
});
