import test from 'node:test';
import assert from 'node:assert/strict';
import {isolated,key,controlledMoneyClock} from './payment-money-fixture.mjs';
import {paymentFixture} from './payment-fix1-fixture.mjs';
import {paid,candidate,sign,collect} from './amendment-money-fixture.mjs';
import {processingProfile,foreignSupplement,pendingStandaloneSupplement,reports} from './amendment-money-fix1-fixture.mjs';
async function setup(f){
 await f.migrateThrough(21);
 await f.owner.query('UPDATE campus.agreement_amendment_settings SET mutations_enabled=true,strict_binding=true WHERE singleton');
 const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock);await processingProfile(f,x);
 const s=await x.prepare({team:true,stages:[5000,5000],fee:100});await paid(f,x,s,100);
 return {clock,x,s};
}
async function funded(f,x,s){const c=await candidate(f,x,s);await sign(f,s,c);await collect(f,x,s,c);return c;}
const assess=(f,s,c)=>f.market.assessAmendmentFinancialPlan(s.P,s.g.id,c.aid,1,{...c.exact,digest:c.p.digest},key());
const activate=(f,s,c)=>f.market.activateAmendmentFinancialPlan(s.P,s.g.id,c.aid,1,{...c.exact,digest:c.p.digest},key());
const cashBalance=async(f,x)=>Number((await f.owner.query("SELECT sum(debit-credit) n FROM campus.ledger_lines l JOIN campus.ledger_journals j ON j.id=l.journal_id WHERE j.environment_id=$1 AND account='cash'",[x.env.id])).rows[0].n);

test('foreign 20 cent cash with only 1 cent typed attribution blocks until exact remaining 19 cents arrive',async()=>{
 const f=await isolated();try{
  const {clock,x,s}=await setup(f),other=await x.prepare({fee:100});await paid(f,x,other,100);
  const charge=(await x.adapter.retrieveCheckoutAndPayment((await x.expected(other)).sessionId)).charge.id;
  const c=await funded(f,x,s),baseline=(await f.owner.query('SELECT baseline FROM campus.amendment_financial_plans WHERE id=$1',[c.p.planId])).rows[0].baseline;
  const h=await reports(f,x,clock),before=await cashBalance(f,x),bid=await h.cash(20);
  assert.equal(await cashBalance(f,x),before-20);
  await h.report([{bid,charge,amount:1}]);
  assert.equal((await f.owner.query('SELECT sum(amount_cents)::int n FROM campus.payment_fee_attributions WHERE balance_id=$1',[bid])).rows[0].n,1);
  const blocked=await activate(f,s,c);assert.equal(blocked.receipt.status,'blocked');assert.equal(blocked.receipt.reason,'environment_evidence_changed');
  assert.equal((await f.market.agreement(s.P,s.g.id)).effectiveTerms.id,s.b.terms_id);
  const remainder=await h.report([{bid,charge,amount:19},{bid,charge,amount:0}]);
  const zero=remainder.rows.find(r=>r.amountCents===0);assert.ok(zero);assert.equal((await f.owner.query("SELECT count(*)::int n FROM campus.ledger_journals WHERE source_effect=ANY($1::text[])",[['fee_attribution_global:'+zero.semanticId,'fee_attribution_lot:'+zero.semanticId]])).rows[0].n,0,'zero attribution omits both journals exactly');
  assert.equal(await cashBalance(f,x),before-20,'attribution never debits cash again');
  assert.deepEqual((await f.owner.query('SELECT baseline FROM campus.amendment_financial_plans WHERE id=$1',[c.p.planId])).rows[0].baseline,baseline);
  assert.equal((await assess(f,s,c)).receipt.status,'ready');assert.equal((await activate(f,s,c)).receipt.status,'effective');
 }finally{await f.close();}
});

test('unrelated supplemental charge report is exactly attributed without staling funded candidate',async()=>{
 const f=await isolated();try{
  const {clock,x,s}=await setup(f),other=await foreignSupplement(f,x,clock),c=await funded(f,x,s),h=await reports(f,x,clock);
  const before=await cashBalance(f,x),bid=await h.cash(10);await h.report([{bid,charge:other.charge,amount:10}]);
  assert.equal((await f.owner.query('SELECT sum(amount_cents)::int n FROM campus.payment_fee_supplement_attributions WHERE balance_id=$1',[bid])).rows[0].n,10);
  assert.equal(await cashBalance(f,x),before-10);
  assert.equal((await assess(f,s,c)).receipt.status,'ready');assert.equal((await activate(f,s,c)).receipt.status,'effective');
 }finally{await f.close();}
});

for(const mode of ['conflict','unmatched'])test('adapter parsed header-only zero effects and independent '+mode+' rejection',async()=>{
 const f=await isolated();try{
  const {clock,x,s}=await setup(f),c=await funded(f,x,s),h=await reports(f,x,clock),before=await cashBalance(f,x);
  const empty=await h.report();assert.deepEqual(empty.rows,[]);
  const artifact=(await f.owner.query('SELECT * FROM campus.payment_fee_report_artifacts WHERE run_id=$1',[empty.runId])).rows[0];assert.equal(artifact.content_digest,empty.contentDigest);
  assert.deepEqual((await f.owner.query('SELECT content_digest,semantic_ids FROM campus.amendment_fee_report_contents WHERE run_id=$1',[empty.runId])).rows[0],{content_digest:empty.contentDigest,semantic_ids:[]});
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_report_memberships WHERE run_id=$1',[empty.runId])).rows[0].n,0);
  assert.equal(await cashBalance(f,x),before);assert.equal((await assess(f,s,c)).receipt.status,'ready');
  const malformed=await h.report([],{csv:'invalid_header\n',malformed:true});assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_report_artifacts WHERE run_id=$1',[malformed.runId])).rows[0].n,0);
  assert.equal((await assess(f,s,c)).receipt.status,'ready','malformed report is rejected before artifact ingestion');
  if(mode==='unmatched'){const bid=await h.cash(20);assert.equal((await activate(f,s,c)).receipt.status,'blocked');
  await h.report([{bid,charge:'ch_unknown_unattributable',amount:20}]);assert.equal((await assess(f,s,c)).receipt.status,'blocked');
  return;}
  // Re-observation on an otherwise-ready candidate independently proves a conflict blocks.
  // The ordinary writer retains a conflicted artifact identity.
  const changed={runId:empty.runId,fileId:empty.fileId,contentDigest:'0'.repeat(64),reportType:artifact.report_type,intervalStart:1,intervalEnd:2,rows:[]};
  assert.equal(await f.store.workerTx(async client=>(await client.query('SELECT campus.money_fee_report($1,$2) ok',[x.env.id,changed])).rows[0].ok),false);
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_evidence_conflicts')).rows[0].n,1);
  assert.equal((await activate(f,s,c)).receipt.status,'blocked');
 }finally{await f.close();}
});


test('unrelated standalone supplemental report and exact closure settle while candidate baseline remains valid',async()=>{
 const f=await isolated();try{
  const {clock,x,s}=await setup(f),h=await reports(f,x,clock),other=await pendingStandaloneSupplement(f,x,clock,h),c=await funded(f,x,s);
  const before=await cashBalance(f,x),bid=await h.cash(10),report=await h.report([{bid,charge:other.charge,amount:10}]);
  assert.equal(await cashBalance(f,x),before-10);
  assert.equal((await f.market.paymentFeeRevision(other.s.P,other.s.q.obligationId)).state,'awaiting_fee_facts');
  await other.close(other.charge,report);for(let i=0;i<5;i++)await h.worker.tick();
  const settled=await f.market.paymentFeeRevision(other.s.P,other.s.q.obligationId);assert.equal(settled.state,'settled');assert.equal(settled.settledActualFeeCents,'410');
  assert.equal((await f.owner.query('SELECT sum(amount_cents)::int n FROM campus.payment_fee_supplement_attributions WHERE balance_id=$1',[bid])).rows[0].n,10);
  assert.equal([...x.transport.refunds.values()].filter(r=>r.charge===other.charge).reduce((n,r)=>n+r.amount,0),10);
  assert.equal(await cashBalance(f,x),before-20,'one cash fee debit and one exact foreign source reserve refund');
  assert.equal((await assess(f,s,c)).receipt.status,'ready');assert.equal((await activate(f,s,c)).receipt.status,'effective');
 }finally{await f.close();}
});
