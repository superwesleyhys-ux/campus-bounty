import test from 'node:test';import assert from 'node:assert/strict';
import {isolated,controlledMoneyClock,key} from './payment-money-fixture.mjs';
import {paymentFixture} from './payment-fix1-fixture.mjs';
test('new personal cap plan collects maximum once and refunds unused payer reserve; frozen018 allocations remain unchanged; synthetic inline closure',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock);
  let originalAllocations;
  const s=await x.prepare({cap:true,fee:300,team:true,stages:[5000,5000],beforeConfirm:async data=>{
   assert.equal(data.plan.current.plan.maximumFeeCents,330);assert.equal(data.plan.current.plan.maximumPlan.lots[0].chargeTotalCents,10165);assert.match(data.plan.current.plan.restoration,/original charge/);
   originalAllocations=(await f.owner.query('SELECT * FROM campus.payee_allocations WHERE transaction_terms_id=$1 ORDER BY component_id',[data.tt.id])).rows;
   await assert.rejects(f.market.createAgreementPaymentQuote(data.P,data.g.id,data.quoteRequest,key()),{code:'fee_plan_confirmation_required'});
   await assert.rejects(f.market.confirmPaymentFeePlan(await f.user('Outsider'),data.plan.receipt.planId,{digest:data.plan.receipt.digest},key()),{code:'not_found'});
  }});
  assert.equal(s.q.quote.chargeTotalCents,10165);assert.ok(s.q.quote.feePlanId);
  await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:200});await x.worker.tick();
  const settlement=(await f.owner.query('SELECT * FROM campus.payment_fee_settlements WHERE obligation_id=$1',[s.q.obligationId])).rows[0];assert.equal(settlement.actual_fee_cents,'200');assert.equal(settlement.restitution_cents,'65');
  assert.equal(x.transport.refunds.size,1);assert.equal([...x.transport.refunds.values()][0].amount,65);
  assert.equal([...x.transport.refunds.values()][0].charge,(await f.market.paymentAttempt(s.P,s.a.attemptId)).chargeId);
  for(const person of s.members)await x.onboard(person);await x.accept(s,0);await x.worker.tick();await x.worker.tick();
  assert.equal(x.transport.transfers.size,2);assert.equal([...x.transport.transfers.values()].reduce((n,v)=>n+v.amount,0),4950);
  await x.accept(s,1);await x.worker.tick();await x.worker.tick();assert.equal([...x.transport.transfers.values()].reduce((n,v)=>n+v.amount,0),9900);
  assert.deepEqual((await f.owner.query('SELECT * FROM campus.payee_allocations WHERE transaction_terms_id=$1 ORDER BY component_id',[s.tt.id])).rows,originalAllocations);
  for(let n=0;n<2;n++){await clock.advance(61000);await x.worker.tick();}assert.equal(x.transport.refunds.size,1);
  const cash=(await f.owner.query("SELECT sum(debit-credit) AS amount FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND account='cash'",[x.env.id])).rows[0].amount;assert.equal(cash,'0');
 }finally{await f.close();}
});

test('standalone zero stays pending; separate cash and delayed report attribution settle once under exact synthetic artifact; conflicts block prequeued spend',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock);
  const profile=key();const contract={kind:'synthetic_report_artifact_v1',processingFeatures:[{product:'Synthetic payments',feature:'Synthetic processing'},{product:'Synthetic payments',feature:'Synthetic network'}]};
  await f.owner.query("INSERT INTO campus.payment_billing_profiles(id,environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,$2,2,$3,'standalone',$4,'Synthetic: exact fake artifact closure only')",[profile,x.env.id,x.env.platformAccountId,JSON.stringify(contract)]);
  const s=await x.prepare({cap:true,fee:300});await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:0});await x.worker.tick();await x.onboard(s.C);await x.accept(s);
  assert.equal((await f.market.agreementFunding(s.P,s.g.id)).feeState,'fee_actual_pending');assert.equal(x.transport.transfers.size,0);assert.equal(x.transport.refunds.size,0);
  const objects=await x.adapter.retrieveCheckoutAndPayment(ex.sessionId),bid='txn_later_'+key();
  x.transport.balances.set(bid,{id:bid,type:'stripe_fee',currency:'usd',amount:-300,fee:0,net:-300,status:'available'});
  await clock.advance(31000);await x.worker.fees();
  const cash=async()=>Number((await f.owner.query("SELECT sum(debit-credit) n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND account='cash'",[x.env.id])).rows[0].n);
  assert.equal(await cash(),9865);assert.equal(x.transport.transfers.size,0);
  const {parseFeeCsv,sha256,FEE_REPORT_TYPE}=await import('../../backend/payments/fee-reports.mjs');
  const csv='balance_transaction_id,fee_transaction_id,incurred_by,incurred_by_type,amount,tax,currency,product,feature_name,settled_via\n'+`${bid},fee_synthetic_a,${objects.charge.id},charge,2.00,0.00,usd,Synthetic payments,Synthetic processing,balance\n${bid},fee_synthetic_b,${objects.charge.id},charge,1.00,0.00,usd,Synthetic payments,Synthetic network,balance\n`;
  const rows=parseFeeCsv(csv,x.env.platformAccountId),runId='frr_'+key(),fileId='file_'+key(),run={id:runId,livemode:false,status:'succeeded',report_type:FEE_REPORT_TYPE,parameters:{interval_start:1,interval_end:2,currency:'usd'},result:{id:fileId,purpose:'finance_report_run'}};
  x.transport.client.reporting.reportRuns.list=async()=>({data:[run],has_more:false});x.transport.client.reporting.reportRuns.retrieve=async()=>run;x.transport.client.files={retrieve:async()=>({id:fileId,purpose:'finance_report_run',url:'https://files.stripe.com/synthetic_report',size:Buffer.byteLength(csv)})};
  const {createStripePayments}=await import('../../backend/adapters/stripe-payments.mjs');const {createPaymentWorker}=await import('../../backend/adapters/payment-worker.mjs');const worker=createPaymentWorker(f.store,createStripePayments({client:x.transport.client,environment:x.env,reportTransport:async()=>csv}));
  await clock.advance(31000);await worker.fees();assert.equal(await cash(),9865,'attribution must not debit cash again');assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_attributions')).rows[0].n,2);
  await worker.tick();assert.equal(x.transport.transfers.size,0,'report availability alone is not closure');
  const closure={chargeId:objects.charge.id,runId,fileId,contentDigest:sha256(csv),intervalStart:1,intervalEnd:2,semanticIds:rows.map(r=>r.semanticId).sort()};
  await f.owner.query("INSERT INTO campus.payment_synthetic_fee_closures VALUES($1,$2,$3,$4,'Synthetic: exact retrieved artifact and semantic set only')",[profile,x.env.id,objects.charge.id,JSON.stringify(closure)]);
  await worker.tick();await worker.tick();assert.equal(x.transport.refunds.size,1);assert.equal([...x.transport.refunds.values()][0].amount,15);assert.equal(x.transport.transfers.size,1);assert.equal([...x.transport.transfers.values()][0].amount,9850);assert.equal(await cash(),0);
  await clock.advance(61000);await worker.fees();assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_attributions')).rows[0].n,2);
  const overlap={...run,id:'frr_overlap_'+key(),parameters:{...run.parameters,interval_start:0,interval_end:3},result:{id:'file_overlap_'+key(),purpose:'finance_report_run'}};
  x.transport.client.reporting.reportRuns.list=async()=>({data:[overlap,run],has_more:false});
  x.transport.client.reporting.reportRuns.retrieve=async id=>id===overlap.id?overlap:run;
  x.transport.client.files.retrieve=async id=>({id,purpose:'finance_report_run',url:'https://files.stripe.com/synthetic_report',size:Buffer.byteLength(csv)});
  await clock.advance(61000);await worker.fees();
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_report_artifacts')).rows[0].n,2);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_report_memberships')).rows[0].n,4);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,1);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_attributions')).rows[0].n,2);
  assert.equal(await cash(),0);assert.equal(x.transport.refunds.size,1);assert.equal(x.transport.transfers.size,1);
  // A newer inline profile applies only to newly quoted obligations.
  await f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,3,$2,'inline',$3,'Synthetic: subsequent old-version inline scenario')",[x.env.id,x.env.platformAccountId,JSON.stringify({kind:'synthetic_original_charge_balance_v1'})]);
  const q=await x.prepare({fee:300});await x.worker.dispatch();const qe=await x.expected(q);x.transport.pay(qe.sessionId,{fee:300});for(let n=0;n<8&&(await f.market.paymentAttempt(q.P,q.a.attemptId)).status!=='succeeded';n++)await worker.reconcile();await x.onboard(q.C);await x.accept(q);await x.sql('SELECT campus.money_prepare_transfers($1,$2) AS result',[x.env.id,q.q.obligationId]);
  const queued=(await f.owner.query("SELECT id FROM campus.money_operations WHERE obligation_id=$1 AND kind='transfer' AND status='queued'",[q.q.obligationId])).rows[0];assert.ok(queued);
  x.transport.balances.get(bid).amount=-400;x.transport.balances.get(bid).net=-400;await clock.advance(61000);await worker.fees();const before=x.transport.calls.length;await worker.dispatch();assert.equal(x.transport.calls.length,before,'conflict blocks operation reserved before conflict even nonnegative raw cash');
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_evidence_conflicts')).rows[0].n,1);
  const another='txn_factual_'+key();x.transport.balances.set(another,{id:another,type:'stripe_fee',currency:'usd',amount:-10,fee:0,net:-10,status:'available'});await clock.advance(61000);await worker.fees();assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,2,'incoming distinct cash remains recordable under conflict');
 }finally{await f.close();}
});

test('fee-reserve restitution unknown response reuses key; failed refund cash restoration waits for availability before a new exact refund generation',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({cap:true,fee:300});await x.worker.dispatch();const ex=await x.expected(s);
  const create=x.transport.client.refunds.create;let first=true,lost=true,failedId;
  x.transport.client.refunds.create=async(p,o)=>{const r=await create(p,o);if(first){first=false;r.status='pending';failedId=r.id;}if(lost){lost=false;throw Error('synthetic lost restitution response');}return r;};
  x.transport.pay(ex.sessionId,{fee:200});await x.worker.tick();assert.equal(x.transport.refunds.size,1);assert.equal((await f.owner.query("SELECT status FROM campus.money_operations WHERE kind='fee_restitution'")).rows[0].status,'unknown');
  await clock.advance(31000);await x.worker.dispatch();const calls=x.transport.calls.filter(c=>c.kind==='refund');assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].p,calls[1].p);
  x.transport.failRefund(failedId,{available:false});await clock.advance(61000);for(let n=0;n<4;n++)await x.worker.tick();assert.equal(x.transport.refunds.size,1);assert.equal((await f.owner.query("SELECT status FROM campus.money_reservations WHERE kind='fee_restitution'")).rows[0].status,'reserved');
  x.transport.failRefund(failedId,{available:true});await clock.advance(3601000);for(let n=0;n<6;n++)await x.worker.tick();assert.equal(x.transport.refunds.size,2);
  const reservations=(await f.owner.query("SELECT status,cash_debited_cents FROM campus.money_reservations WHERE kind='fee_restitution' ORDER BY status")).rows;assert.deepEqual(reservations.map(x=>x.status),['consumed','released']);
  assert.equal((await f.owner.query("SELECT sum(debit-credit)::text n FROM campus.ledger_lines WHERE account='publisher_fee_liability'")).rows[0].n,'0');
  assert.equal((await f.owner.query("SELECT count(*)::int n FROM campus.ledger_journals WHERE source_effect LIKE 'fee_restitution:%'")).rows[0].n,1);
  await clock.advance(61000);for(let n=0;n<3;n++)await x.worker.tick();assert.equal(x.transport.refunds.size,2);
 }finally{await f.close();}
});
