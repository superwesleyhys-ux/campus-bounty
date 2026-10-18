import {key} from './payment-money-fixture.mjs';
import {agreement,fakeTransport} from './payment-money-scenarios.mjs';
import {digest} from '../../backend/payments/amounts.mjs';
import {createStripePayments} from '../../backend/adapters/stripe-payments.mjs';
import {createPaymentWorker} from '../../backend/adapters/payment-worker.mjs';
export async function paymentFixture(f,clock) {
 const env={id:key(),platformAccountId:'acct_fix1',mode:'sandbox'};
 await f.owner.query("INSERT INTO campus.payment_environments VALUES($1,'stripe','sandbox',$2,'Task2B fix1 synthetic','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',true)",[env.id,env.platformAccountId]);
    await (await import('./payment-money-fixture.mjs')).legacyInlineProfile(f,env.id);
 const collectionBody={kind:'synthetic_usd_card_minimum_v1',presentmentCurrency:'USD',settlementCurrency:'USD',paymentMethodTypes:['card'],minimumChargeCents:50,source:'https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts',accountEvidenceDigest:digest({synthetic:env.id}),accountEvidenceRef:'Synthetic: fixture-only USD settlement and card support'};
 const collectionProfile={id:key(),digest:digest(collectionBody),body:collectionBody};
 await f.owner.query("INSERT INTO campus.payment_collection_profiles(id,environment_id,platform_account_id,version,body,digest,provenance) VALUES($1,$2,$3,1,$4,$5,'Synthetic: isolated USD/card collection premise, no real account activation')",[collectionProfile.id,env.id,env.platformAccountId,JSON.stringify(collectionBody),collectionProfile.digest]);
 const collectionEstimate=(amount)=>({supplementalCollectionProfileId:collectionProfile.id,supplementalCollectionProfileDigest:collectionProfile.digest,supplementalEstimatedForAmountCents:amount});
 const transport=fakeTransport({now:clock?.now}),adapter=createStripePayments({client:transport.client,environment:env}),worker=createPaymentWorker(f.store,adapter);
 const sql=async(q,args=[])=>(await f.store.workerTx(c=>c.query(q,args))).rows[0]?.result;
 async function prepare(opts={}) {
  const setup=await agreement(f,opts),payload={signedPolicyId:setup.pol,feeAdjustment:opts.cap?'capped_actual_v1':'hold_on_variance'};
  await f.owner.query("INSERT INTO campus.payment_execution_policies(environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,'agreement',$2,'collection',1,'approved',$3,$4,'Task2B fix1 synthetic legacy policy')",[env.id,setup.g.id,JSON.stringify(payload),digest(payload)]);
  const gd=await f.market.agreement(setup.P,setup.g.id),b=gd.transaction.bindings[0],tt=gd.transaction.terms[0];
  const quoteRequest={expectedEffectiveTermsId:b.terms_id,expectedEffectiveRevision:b.terms_revision,transactionTermsId:tt.id,transactionTermsRevision:tt.revision};
  if(opts.cap){
   const current=await f.market.paymentFeePlan(setup.P,'agreement',setup.g.id);
   const plan=await f.market.proposePaymentFeePlan(setup.P,'agreement',setup.g.id,{policyVersionId:current.context.policyId,policyDigest:current.context.policyDigest,sourceDigest:current.context.sourceDigest},key());
   if(opts.beforeConfirm)await opts.beforeConfirm({...setup,b,tt,plan,quoteRequest});
   for(const person of [setup.P,...setup.members])await f.market.confirmPaymentFeePlan(person,plan.receipt.planId,{digest:plan.receipt.digest},key());
  }
  const q=(await f.market.createAgreementPaymentQuote(setup.P,setup.g.id,quoteRequest,key())).receipt;
  const attemptRequest={quoteId:q.quoteId,quoteDigest:q.quoteDigest,expectedObligationRevision:q.obligationRevision,acceptedAmountCents:q.quote.chargeTotalCents,currency:'USD'};
  const a=(await f.market.createPaymentAttempt(setup.P,q.obligationId,attemptRequest,key())).receipt;
  return {...setup,b,tt,q,a,quoteRequest,attemptRequest};
 }
 async function expected(s){const a=await f.market.paymentAttempt(s.P,s.a.attemptId);return sql('SELECT campus.money_find_attempt($1,$2) AS result',[env.id,a.sessionId]);}
 async function accept(s,index=0){let gd=await f.market.agreement(s.C,s.g.id),m=gd.milestones[index];await f.market.submitMilestone(s.C,m.id,{expectedVersion:m.version,expectedRevision:m.revision,content:'Exact completed work',expectedEffectiveTermsId:s.b.terms_id,expectedEffectiveRevision:s.b.terms_revision},key());gd=await f.market.agreement(s.P,s.g.id);m=gd.milestones[index];await f.market.acceptMilestone(s.P,m.id,{submissionId:m.latest_submission_id,expectedVersion:m.version,expectedRevision:m.revision,submissionTermsId:s.b.terms_id,submissionTermsRevision:s.b.terms_revision,transactionTermsId:s.tt.id,transactionTermsRevision:s.tt.revision},key());}
 async function onboard(user){const conf={configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{requested:true}}}}}};await f.owner.query("INSERT INTO campus.payment_recipient_configurations VALUES($1,$2,1,$3,$4,'Task2B fix1 synthetic recipient configuration')",[env.id,user,JSON.stringify(conf),digest(conf)]);await f.market.onboardPaymentAccount(user,{expectedAccountRevision:0},key());await worker.dispatch();await worker.refreshRecipients();}
 return {env,transport,adapter,worker,sql,prepare,expected,accept,onboard,collectionProfile,collectionEstimate};
}
export async function compensationDecision(f,x,s,amount,version,kind='refund',originalOperationId=null){
 const component=(await f.owner.query('SELECT cp.* FROM campus.funding_component_plans cp JOIN campus.funding_lots l ON l.id=cp.lot_id WHERE l.obligation_id=$1 ORDER BY cp.stage_position LIMIT 1',[s.q.obligationId])).rows[0];
 const funding=await f.market.agreementFunding(s.P,s.g.id);
 const obligation=(await f.owner.query('SELECT * FROM campus.funding_obligations WHERE id=$1',[s.q.obligationId])).rows[0];
 const charge=(await f.owner.query('SELECT charge_id FROM campus.funding_allocations WHERE lot_id=$1',[component.lot_id])).rows[0].charge_id;
 const request=(await f.market.requestPaymentRefund(s.P,'agreement',s.g.id,{obligationId:s.q.obligationId,chargeId:charge,expectedPaymentRevision:funding.paymentRevision,amountCents:amount,reason:'Synthetic compensation review for exact original component',policyVersionId:obligation.policy_id},key())).receipt;
 const approvedHoldIds=(await f.owner.query('SELECT id FROM campus.payment_holds WHERE obligation_id=$1 AND active',[s.q.obligationId])).rows.map(r=>r.id);
 const id=key(),pid=key(),payload={decisionId:id,componentId:component.id,amountCents:amount,approvedHoldIds};
 await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'agreement',$3,$4,$5,'approved',$6,$7,'Task2B fix1 synthetic exact compensation authority; no operator workflow claim')",[pid,x.env.id,s.g.id,kind,version,JSON.stringify(payload),digest(payload)]);
 await f.owner.query("INSERT INTO campus.payment_compensation_decisions(id,environment_id,obligation_id,policy_id,component_id,kind,amount_cents,original_operation_id,request_id,case_revision,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'Task2B fix1 synthetic exact decision')",[id,x.env.id,s.q.obligationId,pid,component.id,kind,amount,originalOperationId,request.requestId]);
 return {id,component};
}
