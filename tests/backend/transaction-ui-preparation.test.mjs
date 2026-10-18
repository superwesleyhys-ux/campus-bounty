import test from 'node:test';
import assert from 'node:assert/strict';
import {isolated,key} from './transaction-ui-fixture.mjs';
import {configure} from './transaction-ui-setup.mjs';
import {agreement} from './transaction-ui-journeys.mjs';

test('fresh service application, exact personal consent, preparation, funding quote and own recipient configuration without per-object owner writes',async()=>{
 const f=await isolated();try{
  await f.migrateThrough(22);const x=await configure(f);
  const s=await agreement(f,{team:true});
  const p=await f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key());
  const again=await f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key());assert.equal(p.receipt.policyVersionId,again.receipt.policyVersionId);
  const v=await f.market.participantPayment(s.P,'agreement',s.g.id);assert.equal(v.preparationBlocker,null);
  const fp=await f.market.proposePaymentFeePlan(s.P,'agreement',s.g.id,{policyVersionId:v.feePlan.context.policyId,policyDigest:v.feePlan.context.policyDigest,sourceDigest:v.feePlan.context.sourceDigest},key());
  assert.equal(fp.current.plan.estimatedFeeCents,100);assert.equal(fp.current.plan.maximumFeeCents,110);
  for(const actor of [s.P,...s.members])await f.market.confirmPaymentFeePlan(actor,fp.receipt.planId,{digest:fp.receipt.digest},key());
  const gd=await f.market.agreement(s.P,s.g.id),b=gd.transaction.bindings[0],tt=gd.transaction.terms[0];
  const q=(await f.market.createAgreementPaymentQuote(s.P,s.g.id,{expectedEffectiveTermsId:b.terms_id,expectedEffectiveRevision:b.terms_revision,transactionTermsId:tt.id,transactionTermsRevision:tt.revision},key())).receipt;
  assert.equal(q.quote.chargeTotalCents,10055);
  const prepared=await f.market.preparePaymentRecipient(s.C,{},key());assert.equal(prepared.receipt.userId,s.C);
  const op=await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:0},key());await x.worker.dispatch();await x.worker.refreshRecipients();
  const acct=await f.market.paymentAccount(s.C);assert.equal(acct.transferCapability,'active');assert.equal(acct.operation.operationId,op.receipt.operationId);assert.equal(acct.requirements.status,'unknown');
  const stranger=await f.user('Stranger');await assert.rejects(f.market.preparePaymentTerms(stranger,'agreement',s.g.id,{},key()),{code:'not_found'});
  await assert.rejects(f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{approved:true},key()),{code:'validation_error'});
 }finally{await f.close();}
});
