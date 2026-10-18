import assert from 'node:assert/strict';
import {key} from './payment-money-fixture.mjs';
import {feePolicy,revision,confirmations,start} from './payment-fix2-fixture.mjs';
import {paid} from './amendment-money-fixture.mjs';
import {createStripePayments} from '../../backend/adapters/stripe-payments.mjs';
import {createPaymentWorker} from '../../backend/adapters/payment-worker.mjs';
import {FEE_REPORT_TYPE,parseFeeCsv,sha256} from '../../backend/payments/fee-reports.mjs';
export const features=[{product:'Synthetic payments',feature:'Synthetic processing'}];
export async function processingProfile(f,x){
 await f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,2,$2,'inline',$3,'Synthetic: explicit processing feature for fix1')",[x.env.id,x.env.platformAccountId,JSON.stringify({kind:'synthetic_original_charge_balance_v1',processingFeatures:features})]);
}
export async function foreignSupplement(f,x,clock){
 const s=await x.prepare({cap:true,fee:300});await paid(f,x,s,400);
 const p=await feePolicy(f,x,s),r=await revision(f,s,p);await confirmations(f,s,r);const a=await start(f,s,r);
 await x.worker.dispatch();const expected=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) result',[x.env.id,a.receipt.attemptId]);
 x.transport.pay(expected.sessionId,{fee:10});await clock.advance(61000);for(let i=0;i<5;i++)await x.worker.tick();
 assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'settled');
 const objects=await x.adapter.retrieveCheckoutAndPayment(expected.sessionId);return {s,charge:objects.charge.id};
}
export async function reports(f,x,clock){
 const runs=new Map(),files=new Map();
 x.transport.client.reporting.reportRuns.list=async()=>({data:[...runs.values()],has_more:false});
 x.transport.client.reporting.reportRuns.retrieve=async id=>runs.get(id);
 x.transport.client.files={retrieve:async id=>files.get(id).file};
 const worker=createPaymentWorker(f.store,createStripePayments({client:x.transport.client,environment:x.env,reportTransport:async url=>[...files.values()].find(v=>v.file.url===url).csv}));
 const header='balance_transaction_id,fee_transaction_id,incurred_by,incurred_by_type,amount,tax,currency,product,feature_name,settled_via\n';
 async function scan(){await clock.advance(61000);await worker.fees();}
 async function cash(amount){const bid='txn_'+key();x.transport.balances.set(bid,{id:bid,type:'stripe_fee',currency:'usd',amount:-amount,fee:0,net:-amount,status:'available'});await scan();return bid;}
 async function report(rows=[],options={}){
  const runId=options.runId??'frr_'+key(),fileId=options.fileId??'file_'+key();
  const csv=options.csv??header+rows.map(r=>`${r.bid},${r.feeId??'fee_'+key()},${r.charge},charge,${(r.amount/100).toFixed(2)},0.00,usd,Synthetic payments,Synthetic processing,balance\n`).join('');
  runs.set(runId,{id:runId,livemode:false,status:'succeeded',report_type:FEE_REPORT_TYPE,parameters:{interval_start:1,interval_end:2,currency:'usd'},result:{id:fileId,purpose:'finance_report_run'}});
  files.set(fileId,{csv,file:{id:fileId,purpose:'finance_report_run',url:'https://files.stripe.com/'+fileId,size:Buffer.byteLength(csv)}});
  await scan();return {runId,fileId,csv,contentDigest:sha256(csv),rows:options.malformed?[]:parseFeeCsv(csv,x.env.platformAccountId)};
 }
 return {worker,scan,cash,report,header};
}

// A supported standalone supplement whose own report/closure can arrive after a candidate baseline.
export async function pendingStandaloneSupplement(f,x,clock,h){
 const profile=key();
 await f.owner.query("INSERT INTO campus.payment_billing_profiles(id,environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,$2,3,$3,'standalone',$4,'Synthetic: exact foreign original and supplemental report artifacts')",[profile,x.env.id,x.env.platformAccountId,JSON.stringify({kind:'synthetic_report_artifact_v1',processingFeatures:features})]);
 const close=async(charge,report)=>f.owner.query("INSERT INTO campus.payment_synthetic_fee_closures VALUES($1,$2,$3,$4,'Synthetic: exact foreign charge report artifact')",[profile,x.env.id,charge,JSON.stringify({chargeId:charge,runId:report.runId,fileId:report.fileId,contentDigest:report.contentDigest,intervalStart:1,intervalEnd:2,semanticIds:report.rows.filter(r=>r.incurredBy===charge).map(r=>r.semanticId).sort()})]);
 const s=await x.prepare({cap:true,fee:300});await paid(f,x,s,0);
 const original=(await x.adapter.retrieveCheckoutAndPayment((await x.expected(s)).sessionId)).charge.id;
 const bid=await h.cash(400),report=await h.report([{bid,charge:original,amount:400}]);await close(original,report);await h.worker.tick();
 const p=await feePolicy(f,x,s),r=await revision(f,s,p);await confirmations(f,s,r);const a=await start(f,s,r);
 await h.worker.dispatch();const expected=await x.sql('SELECT campus.money_fee_supplement_expected($1,$2) result',[x.env.id,a.receipt.attemptId]);
 x.transport.pay(expected.sessionId,{fee:0});await clock.advance(61000);for(let i=0;i<3;i++)await h.worker.tick();
 const charge=(await x.adapter.retrieveCheckoutAndPayment(expected.sessionId)).charge.id;
 assert.equal((await f.market.paymentFeeRevision(s.P,s.q.obligationId)).state,'awaiting_fee_facts');
 // New candidate uses the ordinary supported inline profile; foreign bindings retain standalone.
 await f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,4,$2,'inline',$3,'Synthetic: candidate inline profile after foreign setup')",[x.env.id,x.env.platformAccountId,JSON.stringify({kind:'synthetic_original_charge_balance_v1',processingFeatures:features})]);
 return {s,charge,close};
}
