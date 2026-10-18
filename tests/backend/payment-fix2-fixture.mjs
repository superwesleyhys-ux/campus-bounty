import {key} from './payment-money-fixture.mjs';
import {digest} from '../../backend/payments/amounts.mjs';
import {createStripePayments} from '../../backend/adapters/stripe-payments.mjs';
import {createPaymentWorker} from '../../backend/adapters/payment-worker.mjs';
import {FEE_REPORT_TYPE} from '../../backend/payments/fee-reports.mjs';
export async function feePolicy(f,x,s,{estimate=20,collectible=50,version,profile=x.collectionProfile}={}){
 const o=(await f.owner.query('SELECT * FROM campus.funding_obligations WHERE id=$1',[s.q.obligationId])).rows[0],old=(await f.owner.query('SELECT * FROM campus.payment_execution_policies WHERE id=$1',[o.policy_id])).rows[0];
 version??=(await f.owner.query("SELECT max(version)+1 n FROM campus.payment_execution_policies WHERE environment_id=$1 AND aggregate_id=$2 AND purpose='collection'",[x.env.id,s.g.id])).rows[0].n;
 const id=key(),payload={...old.payload,originalObligationId:o.id,originalSourceDigest:o.source_digest,supplementalEstimatedFeeCents:estimate,supplementalEstimatedForAmountCents:collectible,supplementalCollectionProfileId:profile.id,supplementalCollectionProfileDigest:profile.digest};
 await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,'collection',$4,'approved',$5,$6,'Synthetic: exact collectible amount/method/profile fee estimate, no real rate')",[id,x.env.id,s.g.id,version,JSON.stringify(payload),digest(payload)]);return {id,payload,digest:digest(payload)};
}
export async function revision(f,s,p){const read=await f.market.paymentFeeRevision(s.P,s.q.obligationId);return f.market.proposePaymentFeeRevision(s.P,s.q.obligationId,{policyVersionId:p.id,policyDigest:p.digest,evidenceDigest:read.evidenceDigest},key());}
export async function confirmations(f,s,r){for(const actor of [s.P,...s.members])await f.market.confirmPaymentFeeRevision(actor,r.receipt.revisionId,{digest:r.receipt.digest},key());}
export async function start(f,s,r){return f.market.startPaymentFeeSupplement(s.P,r.receipt.revisionId,{digest:r.receipt.digest,acceptedAmountCents:r.current.plan.supplementalAmountCents},key());}
export async function tick(clock,worker,n=6){await clock.advance(3601000);for(let i=0;i<n;i++)await worker.tick();}
export async function reportHarness(f,x,clock){
 const old=(await f.owner.query('SELECT * FROM campus.payment_billing_profiles WHERE environment_id=$1 ORDER BY version DESC LIMIT 1',[x.env.id])).rows[0];
 await f.owner.query("INSERT INTO campus.payment_billing_profiles(id,environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,$2,$3,$4,'inline',$5,'Synthetic: inline current fee plus exact additional report feature')",[key(),x.env.id,old.version+1,x.env.platformAccountId,JSON.stringify({...old.contract,processingFeatures:[{product:'Synthetic payments',feature:'Synthetic correction'}]})]);
 const runs=new Map(),files=new Map();x.transport.client.reporting.reportRuns.list=async()=>({data:[...runs.values()],has_more:false});x.transport.client.reporting.reportRuns.retrieve=async id=>runs.get(id);x.transport.client.files={retrieve:async id=>files.get(id).file};
 const adapter=createStripePayments({client:x.transport.client,environment:x.env,reportTransport:async url=>[...files.values()].find(x=>x.file.url===url).csv}),worker=createPaymentWorker(f.store,adapter);
 async function add(chargeId,amount){const bid='txn_'+key(),runId='frr_'+key(),fileId='file_'+key();x.transport.balances.set(bid,{id:bid,type:'stripe_fee',currency:'usd',amount:-amount,fee:0,net:-amount,status:'available'});
  const csv='balance_transaction_id,fee_transaction_id,incurred_by,incurred_by_type,amount,tax,currency,product,feature_name,settled_via\n'+`${bid},fee_${key()},${chargeId},charge,${(amount/100).toFixed(2)},0.00,usd,Synthetic payments,Synthetic correction,balance\n`;
  runs.set(runId,{id:runId,livemode:false,status:'succeeded',report_type:FEE_REPORT_TYPE,parameters:{interval_start:1,interval_end:2,currency:'usd'},result:{id:fileId,purpose:'finance_report_run'}});files.set(fileId,{csv,file:{id:fileId,purpose:'finance_report_run',url:'https://files.stripe.com/'+fileId,size:Buffer.byteLength(csv)}});await tick(clock,worker);return bid;
 }return {worker,add};
}
