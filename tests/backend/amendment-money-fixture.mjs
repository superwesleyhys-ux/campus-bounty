import {key} from './payment-money-fixture.mjs';
import {digest} from '../../backend/payments/amounts.mjs';
import {createPosting} from '../../backend/payments/posting.mjs';
async function paid(f,x,s,fee=100){await x.worker.dispatch();const a=await f.market.paymentAttempt(s.P,s.a.attemptId);x.transport.pay(a.sessionId,{fee,available:true});await createPosting(f.store,x.env).payment(await x.expected(s),await x.adapter.retrieveCheckoutAndPayment(a.sessionId));}
async function candidate(f,x,s,{amount=1000,fee=20}={}){
 const gd=await f.market.agreement(s.P,s.g.id),base=gd.effectiveTerms;
 const terms=base.terms;
 const proposed=await f.market.proposeAmendment(s.P,s.g.id,{expectedEffectiveTermsId:base.id,expectedEffectiveRevision:base.revision,reason:'Explicit extra work',terms:{taskTitle:terms.taskTitle,description:terms.description,dueDate:terms.dueDate,rewardCents:terms.rewardCents+amount,currency:'USD',milestones:[...base.milestones.map(m=>({id:m.id,position:m.position,title:m.title,amountCents:m.amountCents,deliverable:m.deliverable,acceptanceCriteria:m.acceptanceCriteria})),{clientReference:'added',title:'Additional report',amountCents:amount,deliverable:'New report',acceptanceCriteria:null}],retireMilestoneIds:[]}},key());
 const a=proposed.amendment??proposed.current?.amendment;
 const aid=proposed.receipt.amendmentId;
 const read=await f.market.agreementAmendment(s.P,s.g.id,aid);
 const ar=read.amendment??read;
 const exact={expectedEffectiveTermsId:ar.baseTerms.id,expectedEffectiveRevision:ar.baseTerms.revision,expectedProposalRevision:ar.proposalRevision,proposedTermsId:ar.proposedTerms.id,proposedTermsRevision:ar.proposedTerms.revision};
 const original=(await f.owner.query('SELECT payload FROM campus.payment_policy_versions WHERE id=$1',[s.pol])).rows[0].payload;
 const max=fee+Math.min(100,Math.ceil(fee/10));
 const payload={...original,feeAdjustment:'capped_actual_v1',principalCents:amount,estimatedProcessorFeeCents:fee,estimatedForAmountCents:amount+Math.ceil(max/2),collectionProfileId:x.collectionProfile.id,collectionProfileDigest:x.collectionProfile.digest};
 const policyId=key();await f.owner.query("INSERT INTO campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES($1,$2,'amendment',$3,'collection',1,'approved',$4,$5,'Synthetic: task2b2 exact prospective card increment')",[policyId,x.env.id,aid,JSON.stringify(payload),digest(payload)]);
 const plan=await f.market.proposeAmendmentFinancialPlan(s.P,s.g.id,aid,{...exact,policyVersionId:policyId,policyDigest:digest(payload)},key());
 return {aid,exact,plan,p:plan.current.plans.at(-1)};
}
async function sign(f,s,c){for(const actor of [s.P,...s.members]){await f.market.confirmAmendment(actor,s.g.id,c.aid,c.exact,key());await f.market.confirmAmendmentFinancialPlan(actor,s.g.id,c.aid,c.p.revision,{...c.exact,digest:c.p.digest,feePlanDigest:c.p.feePlanDigest},key());}}
async function collect(f,x,s,c,fee=20){const q=(await f.market.quoteAmendmentFinancialPlan(s.P,s.g.id,c.aid,c.p.revision,{...c.exact,digest:c.p.digest},key())).receipt;const a=(await f.market.createPaymentAttempt(s.P,q.obligationId,{quoteId:q.quoteId,quoteDigest:q.quoteDigest,expectedObligationRevision:q.obligationRevision,acceptedAmountCents:q.amountCents,currency:'USD'},key())).receipt;await paid(f,x,{...s,a},fee);return {q,a};}
export {paid,candidate,sign,collect};
