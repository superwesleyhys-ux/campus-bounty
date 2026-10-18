import test from 'node:test';import assert from 'node:assert/strict';
import {isolated,controlledMoneyClock,key} from './payment-money-fixture.mjs';
import {paymentFixture} from './payment-fix1-fixture.mjs';
import {digest} from '../../backend/payments/amounts.mjs';
test('over-cap exact personal revision funds one fee-only supplement; worker recovers pending fee/availability and returns unused reserve to that charge',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const workerTx=f.store.workerTx.bind(f.store);f.store.workerTx=async fn=>{try{return await workerTx(fn);}catch(e){console.log('synthetic worker error',e.code,e.message);throw e;}};const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({cap:true,fee:300});
  await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:400});await x.worker.tick();
  assert.equal((await f.market.agreementFunding(s.P,s.g.id)).feeState,'fee_variance_pending');
  const original=(await f.owner.query('SELECT * FROM campus.payee_allocations WHERE transaction_terms_id=$1 ORDER BY component_id',[s.tt.id])).rows;
  const old=(await f.owner.query('SELECT p.* FROM campus.payment_execution_policies p JOIN campus.funding_obligations o ON o.policy_id=p.id WHERE o.id=$1',[s.q.obligationId])).rows[0];
  const policyId=key(),payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:s.q.quote.sourceDigest,supplementalEstimatedFeeCents:20,...x.collectionEstimate(50)};
  // Source digest is immutable authority from the original obligation, not a client assumption.
  payload.originalSourceDigest=(await f.owner.query('SELECT source_digest FROM campus.funding_obligations WHERE id=$1',[s.q.obligationId])).rows[0].source_digest;
  await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',2,'approved',$4,$5,'Synthetic: exact supplementary fee estimate20; no production rate')",[policyId,x.env.id,s.g.id,JSON.stringify(payload),digest(payload)]);
  const before=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.ok(before.allowedActions.includes('propose_fee_revision'));
  const proposed=await f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:policyId,policyDigest:digest(payload),evidenceDigest:before.evidenceDigest},key()),rid=proposed.receipt.revisionId;
  assert.equal(proposed.current.plan.maximumTotalFeeCents,422);assert.equal(proposed.current.plan.supplementalAmountCents,50);
  await assert.rejects(f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:50},key()),{code:'fee_revision_confirmation_required'});
  await assert.rejects(f.market.confirmPaymentFeeRevision(await f.user('outsider'),rid,{digest:proposed.receipt.digest},key()),{code:'not_found'});
  for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,rid,{digest:proposed.receipt.digest},key());
  await assert.rejects(f.market.startPaymentFeeSupplement(s.C,rid,{digest:proposed.receipt.digest,acceptedAmountCents:50},key()),{code:'not_payer'});
  const started=await f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:50},key());
  const repeated=await f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:50},key());assert.equal(repeated.receipt.operationId,started.receipt.operationId);
  await x.worker.dispatch();let current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.ok(current.allowedActions.includes('open_fee_checkout'));
  const expected=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,started.receipt.attemptId]);
  x.transport.pay(expected.sessionId,{fee:null});await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();
  assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');assert.equal(x.transport.refunds.size,0);
  x.transport.setFee(expected.sessionId,10);const object=await x.adapter.retrieveCheckoutAndPayment(expected.sessionId);object.balance.status='pending';
  await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');
  object.balance.status='available';await clock.advance(3601000);for(let n=0;n<8;n++)await x.worker.tick();
  current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);if(current.state!=='settled')console.log('supplement recovery diagnostic',JSON.stringify({jobs:(await f.owner.query('SELECT kind,status,last_code,failures FROM campus.payment_reconciliation_jobs')).rows,receipts:(await f.owner.query('SELECT amount_cents,fee_cents,available_cents FROM campus.payment_fee_supplement_receipts')).rows,base:(await f.owner.query('SELECT base_evidence=campus.money_fee_evidence(obligation_id,id) same FROM campus.payment_fee_revisions')).rows}));assert.equal(current.state,'settled');assert.equal(current.settledActualFeeCents,'410');
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_obligations')).rows[0].n,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,1);
  assert.equal(x.transport.refunds.size,1);const refund=[...x.transport.refunds.values()][0];assert.equal(refund.amount,10);assert.equal(refund.charge,object.charge.id);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_hold_resolutions')).rows[0].n,1);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.money_active_holds')).rows[0].n,0);
  await x.onboard(s.C);await x.accept(s);await x.worker.tick();await x.worker.tick();if(!x.transport.transfers.size)console.log('supplement transfer diagnostic',JSON.stringify({funding:(await f.owner.query('SELECT fee_state,available_cents FROM campus.funding_allocations')).rows,payables:(await f.owner.query('SELECT net_cents,release_ready,operation_id FROM campus.payables')).rows,headroom:(await f.owner.query('SELECT campus.money_cash_headroom($1,NULL) AS result',[x.env.id])).rows[0].result,holds:(await f.owner.query('SELECT reason FROM campus.money_active_holds')).rows}));assert.equal([...x.transport.transfers.values()].reduce((n,v)=>n+v.amount,0),9795);
  assert.deepEqual((await f.owner.query('SELECT * FROM campus.payee_allocations WHERE transaction_terms_id=$1 ORDER BY component_id',[s.tt.id])).rows,original);
  assert.equal((await f.owner.query("SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",[x.env.id])).rows[0].n,'0');

  // Authenticated notifications and external cash effects retain fee-only origin.
  const {default:Stripe}=await import('stripe'),{randomBytes}=await import('node:crypto'),{paymentWebhook}=await import('../../backend/http/payment-webhook.mjs'),{createStripePayments}=await import('../../backend/adapters/stripe-payments.mjs');
  const sdk=new Stripe('synthetic-no-network'),secret='whsec_'+randomBytes(24).toString('hex');x.transport.client.webhooks=sdk.webhooks;
  const ingress=createStripePayments({client:x.transport.client,environment:x.env,snapshotSecret:secret}),handler=paymentWebhook(async()=>({paymentAdapter:ingress,store:f.store}));
  const external=await x.transport.client.refunds.create({charge:object.charge.id,amount:1,metadata:{}},{idempotencyKey:'external-supplement-'+key()}),dp={id:'dp_'+key(),charge:object.charge.id,livemode:false,balance_transactions:[]},bt={id:'txn_'+key(),source:null,amount:-1,net:-1,fee:0,currency:'usd',status:'available'};bt.source=dp.id;dp.balance_transactions.push(bt);x.transport.balances.set(bt.id,bt);x.transport.client.disputes={retrieve:async()=>dp};
  for(const [type,id] of [['checkout.session.completed',expected.sessionId],['refund.updated',external.id],['charge.dispute.funds_withdrawn',dp.id]])for(let n=0;n<2;n++){
   const body=JSON.stringify({id:'evt_'+key(),type,livemode:false,data:{object:{id}}});assert.equal((await handler(new Request('http://127.0.0.1/api/v1/webhooks/stripe',{method:'POST',body,headers:{'stripe-signature':sdk.webhooks.generateTestHeaderString({payload:body,secret})}}))).status,200);await x.worker.inbox();
  }
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_supplement_observations')).rows[0].n,2);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_external_balance_facts WHERE supplement_attempt_id=$1',[started.receipt.attemptId])).rows[0].n,1);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_network_balance_facts WHERE supplement_attempt_id=$1',[started.receipt.attemptId])).rows[0].n,1);
  assert.equal((await f.owner.query("SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",[x.env.id])).rows[0].n,'-2');assert.equal((await f.market.agreementFunding(s.P,s.g.id)).coverage,'held');assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,1);
 }finally{await f.close();}
});

test('supplement unknown retries exact operation; expired session permits only new consent revision; above-cap supplemental fee never auto-collects recursively',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({cap:true,fee:300});await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:400});await x.worker.tick();
  const old=(await f.owner.query('SELECT p.*,o.source_digest FROM campus.payment_execution_policies p JOIN campus.funding_obligations o ON o.policy_id=p.id WHERE o.id=$1',[s.q.obligationId])).rows[0],pid=key(),payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:old.source_digest,supplementalEstimatedFeeCents:20,...x.collectionEstimate(50)};
  await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',2,'approved',$4,$5,'Synthetic: explicit supplemental estimate20')",[pid,x.env.id,s.g.id,JSON.stringify(payload),digest(payload)]);
  async function propose(){const now=await f.market.paymentFeeRevision(s.P,s.q.obligationId);return f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:pid,policyDigest:digest(payload),evidenceDigest:now.evidenceDigest},key());}
  async function confirmAndStart(r){for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,r.receipt.revisionId,{digest:r.receipt.digest},key());return f.market.startPaymentFeeSupplement(s.P,r.receipt.revisionId,{digest:r.receipt.digest,acceptedAmountCents:r.current.plan.supplementalAmountCents},key());}
  const r1=await propose(),a1=await confirmAndStart(r1),create=x.transport.client.checkout.sessions.create;let lost=true;
  x.transport.client.checkout.sessions.create=async(...args)=>{const value=await create(...args);if(lost){lost=false;throw Error('synthetic lost create response');}return value;};
  await x.worker.dispatch();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).attempt.status,'unknown');
  await clock.advance(31000);await x.worker.dispatch();const attempts=x.transport.calls.filter(c=>c.kind==='checkout').slice(-2);assert.equal(attempts[0].key,attempts[1].key);assert.deepEqual(attempts[0].p,attempts[1].p);
  const exp1=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a1.receipt.attemptId]);x.transport.sessions.get(exp1.sessionId).status='expired';
  for(let n=0;n<4;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'unpaid_terminal');
  const replay=await f.market.startPaymentFeeSupplement(s.P,r1.receipt.revisionId,{digest:r1.receipt.digest,acceptedAmountCents:50},key());assert.equal(replay.receipt.attemptId,a1.receipt.attemptId);
  const r2=await propose();await assert.rejects(f.market.confirmPaymentFeeRevision(s.C,r1.receipt.revisionId,{digest:r1.receipt.digest},key()),{code:'fee_evidence_refresh_required'});
  assert.deepEqual(r2.current.confirmedParticipantIds,[]);const a2=await confirmAndStart(r2);await x.worker.dispatch();const exp2=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a2.receipt.attemptId]);x.transport.pay(exp2.sessionId,{fee:50});
  await clock.advance(61000);for(let n=0;n<6;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'fee_reconfirmation_required');assert.ok((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).allowedActions.includes('propose_fee_revision'));assert.ok((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).blockedReasons.includes('fee_cap_reconfirmation_required'));assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_revision_settlements')).rows[0].n,0);
  const count=x.transport.calls.filter(c=>c.kind==='checkout').length;await clock.advance(61000);for(let n=0;n<4;n++)await x.worker.tick();assert.equal(x.transport.calls.filter(c=>c.kind==='checkout').length,count,'no recursive collection');
  const r3=await propose();assert.equal(r3.current.plan.evidence.totalCents,450);assert.equal(r3.current.plan.maximumTotalFeeCents,472);assert.equal(r3.current.plan.supplementalAmountCents,50);assert.deepEqual(r3.current.confirmedParticipantIds,[]);
  const a3=await confirmAndStart(r3);await x.worker.dispatch();const exp3=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a3.receipt.attemptId]);x.transport.pay(exp3.sessionId,{fee:10});await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();
  const current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.equal(current.state,'settled');assert.equal(current.settledActualFeeCents,'460');assert.equal(x.transport.refunds.size,1);assert.equal([...x.transport.refunds.values()][0].amount,35);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_hold_resolutions')).rows[0].n,2);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_supplement_receipts')).rows[0].n,2);
 }finally{await f.close();}
});

test('standalone original and supplemental fee reports attribute distinct cash once and settle only under each exact synthetic charge artifact',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),profile=key();
  await f.owner.query("INSERT INTO campus.payment_billing_profiles(id,environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,$2,2,$3,'standalone',$4,'Synthetic: exact original and supplemental artifact scenario')",[profile,x.env.id,x.env.platformAccountId,JSON.stringify({kind:'synthetic_report_artifact_v1',processingFeatures:[{product:'Synthetic payments',feature:'Synthetic processing'}]})]);
  const {parseFeeCsv,sha256,FEE_REPORT_TYPE}=await import('../../backend/payments/fee-reports.mjs'),{createStripePayments}=await import('../../backend/adapters/stripe-payments.mjs'),{createPaymentWorker}=await import('../../backend/adapters/payment-worker.mjs');
  const runs=new Map(),files=new Map();x.transport.client.reporting.reportRuns.list=async()=>({data:[...runs.values()],has_more:false});x.transport.client.reporting.reportRuns.retrieve=async id=>runs.get(id);x.transport.client.files={retrieve:async id=>files.get(id).file};
  const worker=createPaymentWorker(f.store,createStripePayments({client:x.transport.client,environment:x.env,reportTransport:async url=>[...files.values()].find(x=>x.file.url===url).csv}));
  async function feeReport(chargeId,amount){const bid='txn_later_'+key(),runId='frr_'+key(),fileId='file_'+key();x.transport.balances.set(bid,{id:bid,type:'stripe_fee',currency:'usd',amount:-amount,fee:0,net:-amount,status:'available'});
   const csv='balance_transaction_id,fee_transaction_id,incurred_by,incurred_by_type,amount,tax,currency,product,feature_name,settled_via\n'+`${bid},fee_${key()},${chargeId},charge,${(amount/100).toFixed(2)},0.00,usd,Synthetic payments,Synthetic processing,balance\n`;
   runs.set(runId,{id:runId,livemode:false,status:'succeeded',report_type:FEE_REPORT_TYPE,parameters:{interval_start:1,interval_end:2,currency:'usd'},result:{id:fileId,purpose:'finance_report_run'}});files.set(fileId,{csv,file:{id:fileId,purpose:'finance_report_run',url:'https://files.stripe.com/'+fileId,size:Buffer.byteLength(csv)}});
   await clock.advance(61000);await worker.fees();return {chargeId,runId,fileId,contentDigest:sha256(csv),intervalStart:1,intervalEnd:2,semanticIds:parseFeeCsv(csv,x.env.platformAccountId).map(r=>r.semanticId)};
  }
  async function close(evidence){await f.owner.query("INSERT INTO campus.payment_synthetic_fee_closures VALUES($1,$2,$3,$4,'Synthetic: exact retrieved report for this charge')",[profile,x.env.id,evidence.chargeId,JSON.stringify(evidence)]);}
  const s=await x.prepare({cap:true,fee:300});await worker.dispatch();const original=await x.expected(s);x.transport.pay(original.sessionId,{fee:0});for(let n=0;n<3;n++)await worker.tick();const originalObjects=await x.adapter.retrieveCheckoutAndPayment(original.sessionId);await close(await feeReport(originalObjects.charge.id,400));await worker.tick();
  const old=(await f.owner.query('SELECT p.*,o.source_digest FROM campus.payment_execution_policies p JOIN campus.funding_obligations o ON o.policy_id=p.id WHERE o.id=$1',[s.q.obligationId])).rows[0],pid=key(),payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:old.source_digest,supplementalEstimatedFeeCents:20,...x.collectionEstimate(50)};
  await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',2,'approved',$4,$5,'Synthetic: explicit report-billed supplement estimate20')",[pid,x.env.id,s.g.id,JSON.stringify(payload),digest(payload)]);
  const before=await f.market.paymentFeeRevision(s.P,s.q.obligationId),r=await f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:pid,policyDigest:digest(payload),evidenceDigest:before.evidenceDigest},key());for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,r.receipt.revisionId,{digest:r.receipt.digest},key());const a=await f.market.startPaymentFeeSupplement(s.P,r.receipt.revisionId,{digest:r.receipt.digest,acceptedAmountCents:50},key());
  await worker.dispatch();const expected=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a.receipt.attemptId]);x.transport.pay(expected.sessionId,{fee:0});await clock.advance(61000);for(let n=0;n<5;n++)await worker.tick();
  const object=await x.adapter.retrieveCheckoutAndPayment(expected.sessionId),closure=await feeReport(object.charge.id,10);await worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');assert.equal(x.transport.refunds.size,0);
  await close(closure);for(let n=0;n<5;n++)await worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).settledActualFeeCents,'410');assert.equal(x.transport.refunds.size,1);assert.equal([...x.transport.refunds.values()][0].amount,10);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,2);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_supplement_attributions')).rows[0].n,1);
  await x.onboard(s.C);await x.accept(s);await worker.tick();await worker.tick();assert.equal([...x.transport.transfers.values()].reduce((n,v)=>n+v.amount,0),9795);
  assert.equal((await f.owner.query("SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",[x.env.id])).rows[0].n,'0');
  await feeReport(object.charge.id,1);await worker.tick();
  const changed=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.equal(changed.state,'evidence_changed');assert.ok(changed.blockedReasons.includes('fee_evidence_refresh_required'));assert.equal(changed.settledActualFeeCents,'410','historical settlement remains explicit');
  const funding=await f.market.agreementFunding(s.P,s.g.id);assert.equal(funding.feeRevision.isCurrentEvidence,false);assert.equal(funding.coverage,'held');
  await assert.rejects(f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:pid,policyDigest:digest(payload),evidenceDigest:changed.evidenceDigest},key()),{code:'recipient_fee_recovery_policy_required'});
  assert.equal(x.transport.refunds.size,1);assert.equal(x.transport.transfers.size,1);
 }finally{await f.close();}
});


test('replaced supplemental policy blocks never-dispatched operation and requires a fresh personal revision',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({cap:true,fee:300});
  assert.deepEqual((await f.market.paymentFeePlan(s.P,'agreement',s.g.id)).allowedActions,[]);
  await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:400});await x.worker.tick();
  const old=(await f.owner.query('SELECT p.*,o.source_digest FROM campus.payment_execution_policies p JOIN campus.funding_obligations o ON o.policy_id=p.id WHERE o.id=$1',[s.q.obligationId])).rows[0];
  const payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:old.source_digest,supplementalEstimatedFeeCents:20,...x.collectionEstimate(50)};
  async function policy(version){const id=key();await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',$4,'approved',$5,$6,'Synthetic: exact policy revision')",[id,x.env.id,s.g.id,version,JSON.stringify(payload),digest(payload)]);return id;}
  const p2=await policy(2),read=await f.market.paymentFeeRevision(s.P,s.q.obligationId),r=await f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:p2,policyDigest:digest(payload),evidenceDigest:read.evidenceDigest},key());
  for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,r.receipt.revisionId,{digest:r.receipt.digest},key());
  const a=await f.market.startPaymentFeeSupplement(s.P,r.receipt.revisionId,{digest:r.receipt.digest,acceptedAmountCents:50},key()),p3=await policy(3),count=x.transport.calls.filter(c=>c.kind==='checkout').length;
  await x.worker.dispatch();assert.equal(x.transport.calls.filter(c=>c.kind==='checkout').length,count);assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'evidence_changed');assert.ok(!(await f.market.paymentFeeRevision(s.P,s.q.obligationId)).allowedActions.includes('start_fee_supplement'));
  await assert.rejects(f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:p2,policyDigest:digest(payload),evidenceDigest:read.evidenceDigest},key()),{code:'fee_revision_policy_unavailable'});
  const next=await f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:p3,policyDigest:digest(payload),evidenceDigest:read.evidenceDigest},key());assert.deepEqual(next.current.confirmedParticipantIds,[]);assert.equal((await f.owner.query('SELECT status FROM campus.payment_fee_supplement_attempts WHERE id=$1',[a.receipt.attemptId])).rows[0].status,'canceled');
  await assert.rejects(f.market.startPaymentFeeSupplement(s.P,next.receipt.revisionId,{digest:next.receipt.digest,acceptedAmountCents:50},key()),{code:'fee_revision_confirmation_required'});
 }finally{await f.close();}
});
