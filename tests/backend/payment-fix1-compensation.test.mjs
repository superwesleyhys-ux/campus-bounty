import test from 'node:test';import assert from 'node:assert/strict';
import {isolated,controlledMoneyClock} from './payment-money-fixture.mjs';
import {paymentFixture,compensationDecision} from './payment-fix1-fixture.mjs';
async function fund(f,x,s){await x.worker.dispatch();const ex=await x.expected(s);x.transport.pay(ex.sessionId,{fee:300});for(let i=0;i<16&&(await f.market.paymentAttempt(s.P,s.a.attemptId)).status!=='succeeded';i++)await x.worker.tick();assert.equal((await f.market.paymentAttempt(s.P,s.a.attemptId)).status,'succeeded');}
test('fix1 pending refund cash debit allows exact remaining8500 reservation; autonomous failure restoration and unknown transfers/reversals/refunds retain frozen identities',async()=>{
 const f=await isolated(1);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock),s=await x.prepare({fee:300});await fund(f,x,s);
  await compensationDecision(f,x,s,1000,1);await x.sql('SELECT campus.money_prepare_compensation($1,$2) AS result',[x.env.id,s.q.obligationId]);
  const create=x.transport.client.refunds.create;x.transport.client.refunds.create=async(p,o)=>{const r=await create(p,o);r.status='pending';return r;};await x.worker.dispatch();
  const r=[...x.transport.refunds.values()][0];assert.equal((await f.owner.query("SELECT campus.money_cash_headroom($1,NULL,(SELECT id FROM campus.funding_lots WHERE obligation_id=$2)) AS n",[x.env.id,s.q.obligationId])).rows[0].n,'8850');
  await compensationDecision(f,x,s,8500,2);assert.equal(await x.sql('SELECT campus.money_prepare_compensation($1,$2) AS result',[x.env.id,s.q.obligationId]),1,'actual prepare must not subtract pending debit twice');
  x.transport.failRefund(r.id,{available:false});await x.worker.reconcile();
  assert.equal((await f.owner.query('SELECT status FROM campus.money_reservations WHERE operation_id=$1',[r.metadata.operationId])).rows[0].status,'reserved');
  x.transport.failRefund(r.id,{available:true});await clock.advance(61000);await x.worker.reconcile();
  assert.equal((await f.owner.query('SELECT status FROM campus.money_reservations WHERE operation_id=$1',[r.metadata.operationId])).rows[0].status,'released','available failure balance releases via autonomous exact retrieval');
  x.transport.client.refunds.create=async(p,o)=>{await create(p,o);throw Error('lost_response');};
  const op=(await f.owner.query("SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='refund' AND status='queued'",[s.q.obligationId])).rows[0];await x.worker.dispatch();await clock.advance(10000);x.transport.client.refunds.create=create;await x.worker.dispatch();
  const calls=x.transport.calls.filter(c=>c.key===op.provider_key);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal((await f.owner.query('SELECT status FROM campus.money_reservations WHERE operation_id=$1',[op.id])).rows[0].status,'consumed');
  const t=await x.prepare({fee:300});await fund(f,x,t);await x.onboard(t.C);await x.accept(t);await x.sql('SELECT campus.money_prepare_transfers($1,$2) AS result',[x.env.id,t.q.obligationId]);
  const originalTransfer=x.transport.client.transfers.create;x.transport.client.transfers.create=async(p,o)=>{await originalTransfer(p,o);throw Error('lost_response');};await x.worker.dispatch();
  const transferOp=(await f.owner.query("SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='transfer'",[t.q.obligationId])).rows[0];assert.equal(transferOp.status,'unknown');await clock.advance(10000);x.transport.client.transfers.create=originalTransfer;await x.worker.dispatch();
  const tc=x.transport.calls.filter(c=>c.key===transferOp.provider_key);assert.equal(tc.length,2);assert.deepEqual(tc[0],tc[1]);assert.equal((await f.market.agreementFunding(t.P,t.g.id)).transferredCents,'9850');
  await compensationDecision(f,x,t,1000,1,'reversal',transferOp.id);await x.sql('SELECT campus.money_prepare_compensation($1,$2) AS result',[x.env.id,t.q.obligationId]);
  const reverse=x.transport.client.transfers.createReversal;x.transport.client.transfers.createReversal=async(id,p,o)=>{await reverse(id,p,o);throw Error('lost_response');};await x.worker.dispatch();
  const reversalOp=(await f.owner.query("SELECT * FROM campus.money_operations WHERE obligation_id=$1 AND kind='reversal'",[t.q.obligationId])).rows[0];assert.equal(reversalOp.status,'unknown');await clock.advance(10000);x.transport.client.transfers.createReversal=reverse;await x.worker.dispatch();
  const rc=x.transport.calls.filter(c=>c.key===reversalOp.provider_key);assert.equal(rc.length,2);assert.deepEqual(rc[0],rc[1]);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.principal_restorations WHERE reversal_operation_id=$1',[reversalOp.id])).rows[0].n,1);
 }finally{await f.close();}
});
