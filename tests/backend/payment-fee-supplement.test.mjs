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
  const policyId=key(),payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:s.q.quote.sourceDigest,supplementalEstimatedFeeCents:20};
  // Source digest is immutable authority from the original obligation, not a client assumption.
  payload.originalSourceDigest=(await f.owner.query('SELECT source_digest FROM campus.funding_obligations WHERE id=$1',[s.q.obligationId])).rows[0].source_digest;
  await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',2,'approved',$4,$5,'Synthetic: exact supplementary fee estimate20; no production rate')",[policyId,x.env.id,s.g.id,JSON.stringify(payload),digest(payload)]);
  const before=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.ok(before.allowedActions.includes('propose_fee_revision'));
  const proposed=await f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:policyId,policyDigest:digest(payload),evidenceDigest:before.evidenceDigest},key()),rid=proposed.receipt.revisionId;
  assert.equal(proposed.current.plan.maximumTotalFeeCents,422);assert.equal(proposed.current.plan.supplementalAmountCents,46);
  await assert.rejects(f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:46},key()),{code:'fee_revision_confirmation_required'});
  await assert.rejects(f.market.confirmPaymentFeeRevision(await f.user('outsider'),rid,{digest:proposed.receipt.digest},key()),{code:'not_found'});
  for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,rid,{digest:proposed.receipt.digest},key());
  await assert.rejects(f.market.startPaymentFeeSupplement(s.C,rid,{digest:proposed.receipt.digest,acceptedAmountCents:46},key()),{code:'not_payer'});
  const started=await f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:46},key());
  const repeated=await f.market.startPaymentFeeSupplement(s.P,rid,{digest:proposed.receipt.digest,acceptedAmountCents:46},key());assert.equal(repeated.receipt.operationId,started.receipt.operationId);
  await x.worker.dispatch();let current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.ok(current.allowedActions.includes('open_fee_checkout'));
  const expected=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,started.receipt.attemptId]);
  x.transport.pay(expected.sessionId,{fee:null});await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();
  assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');assert.equal(x.transport.refunds.size,0);
  x.transport.setFee(expected.sessionId,10);const object=await x.adapter.retrieveCheckoutAndPayment(expected.sessionId);object.balance.status='pending';
  await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');
  object.balance.status='available';await clock.advance(3601000);for(let n=0;n<8;n++)await x.worker.tick();
  current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);if(current.state!=='settled')console.log('supplement recovery diagnostic',JSON.stringify({jobs:(await f.owner.query('SELECT kind,status,last_code,failures FROM campus.payment_reconciliation_jobs')).rows,receipts:(await f.owner.query('SELECT amount_cents,fee_cents,available_cents FROM campus.payment_fee_supplement_receipts')).rows,base:(await f.owner.query('SELECT base_evidence=campus.money_fee_evidence(obligation_id,id) same FROM campus.payment_fee_revisions')).rows}));assert.equal(current.state,'settled');assert.equal(current.settledActualFeeCents,'410');
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_obligations')).rows[0].n,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,1);
  assert.equal(x.transport.refunds.size,1);const refund=[...x.transport.refunds.values()][0];assert.equal(refund.amount,6);assert.equal(refund.charge,object.charge.id);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_hold_resolutions')).rows[0].n,1);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.money_active_holds')).rows[0].n,0);
  await x.onboard(s.C);await x.accept(s);await x.worker.tick();await x.worker.tick();if(!x.transport.transfers.size)console.log('supplement transfer diagnostic',JSON.stringify({funding:(await f.owner.query('SELECT fee_state,available_cents FROM campus.funding_allocations')).rows,payables:(await f.owner.query('SELECT net_cents,release_ready,operation_id FROM campus.payables')).rows,headroom:(await f.owner.query('SELECT campus.money_cash_headroom($1,NULL) AS result',[x.env.id])).rows[0].result,holds:(await f.owner.query('SELECT reason FROM campus.money_active_holds')).rows}));assert.equal([...x.transport.transfers.values()].reduce((n,v)=>n+v.amount,0),9795);
  assert.deepEqual((await f.owner.query('SELECT * FROM campus.payee_allocations WHERE transaction_terms_id=$1 ORDER BY component_id',[s.tt.id])).rows,original);
  assert.equal((await f.owner.query("SELECT sum(ll.debit-ll.credit)::text n FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=$1 AND ll.account='cash'",[x.env.id])).rows[0].n,'0');
 }finally{await f.close();}
});

test('supplement unknown retries exact operation; expired session permits only new consent revision; above-cap supplemental fee never auto-collects recursively',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({cap:true,fee:300});await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:400});await x.worker.tick();
  const old=(await f.owner.query('SELECT p.*,o.source_digest FROM campus.payment_execution_policies p JOIN campus.funding_obligations o ON o.policy_id=p.id WHERE o.id=$1',[s.q.obligationId])).rows[0],pid=key(),payload={...old.payload,originalObligationId:s.q.obligationId,originalSourceDigest:old.source_digest,supplementalEstimatedFeeCents:20};
  await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',2,'approved',$4,$5,'Synthetic: explicit supplemental estimate20')",[pid,x.env.id,s.g.id,JSON.stringify(payload),digest(payload)]);
  async function propose(){const now=await f.market.paymentFeeRevision(s.P,s.q.obligationId);return f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:pid,policyDigest:digest(payload),evidenceDigest:now.evidenceDigest},key());}
  async function confirmAndStart(r){for(const actor of [s.P,s.C])await f.market.confirmPaymentFeeRevision(actor,r.receipt.revisionId,{digest:r.receipt.digest},key());return f.market.startPaymentFeeSupplement(s.P,r.receipt.revisionId,{digest:r.receipt.digest,acceptedAmountCents:r.current.plan.supplementalAmountCents},key());}
  const r1=await propose(),a1=await confirmAndStart(r1),create=x.transport.client.checkout.sessions.create;let lost=true;
  x.transport.client.checkout.sessions.create=async(...args)=>{const value=await create(...args);if(lost){lost=false;throw Error('synthetic lost create response');}return value;};
  await x.worker.dispatch();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).attempt.status,'unknown');
  await clock.advance(31000);await x.worker.dispatch();const attempts=x.transport.calls.filter(c=>c.kind==='checkout').slice(-2);assert.equal(attempts[0].key,attempts[1].key);assert.deepEqual(attempts[0].p,attempts[1].p);
  const exp1=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a1.receipt.attemptId]);x.transport.sessions.get(exp1.sessionId).status='expired';
  for(let n=0;n<4;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'unpaid_terminal');
  const replay=await f.market.startPaymentFeeSupplement(s.P,r1.receipt.revisionId,{digest:r1.receipt.digest,acceptedAmountCents:46},key());assert.equal(replay.receipt.attemptId,a1.receipt.attemptId);
  const r2=await propose();await assert.rejects(f.market.confirmPaymentFeeRevision(s.C,r1.receipt.revisionId,{digest:r1.receipt.digest},key()),{code:'fee_evidence_refresh_required'});
  assert.deepEqual(r2.current.confirmedParticipantIds,[]);const a2=await confirmAndStart(r2);await x.worker.dispatch();const exp2=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a2.receipt.attemptId]);x.transport.pay(exp2.sessionId,{fee:50});
  await clock.advance(61000);for(let n=0;n<6;n++)await x.worker.tick();assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'fee_reconfirmation_required');assert.ok((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).allowedActions.includes('propose_fee_revision'));assert.ok((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).blockedReasons.includes('fee_cap_reconfirmation_required'));assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_revision_settlements')).rows[0].n,0);
  const count=x.transport.calls.filter(c=>c.kind==='checkout').length;await clock.advance(61000);for(let n=0;n<4;n++)await x.worker.tick();assert.equal(x.transport.calls.filter(c=>c.kind==='checkout').length,count,'no recursive collection');
  const r3=await propose();assert.equal(r3.current.plan.evidence.totalCents,450);assert.equal(r3.current.plan.maximumTotalFeeCents,472);assert.equal(r3.current.plan.supplementalAmountCents,25);assert.deepEqual(r3.current.confirmedParticipantIds,[]);
  const a3=await confirmAndStart(r3);await x.worker.dispatch();const exp3=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,a3.receipt.attemptId]);x.transport.pay(exp3.sessionId,{fee:10});await clock.advance(61000);for(let n=0;n<8;n++)await x.worker.tick();
  const current=await f.market.paymentFeeRevision(s.P,s.q.obligationId);assert.equal(current.state,'settled');assert.equal(current.settledActualFeeCents,'460');assert.equal(x.transport.refunds.size,1);assert.equal([...x.transport.refunds.values()][0].amount,6);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_hold_resolutions')).rows[0].n,2);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.funding_allocations')).rows[0].n,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_supplement_receipts')).rows[0].n,2);
 }finally{await f.close();}
});
