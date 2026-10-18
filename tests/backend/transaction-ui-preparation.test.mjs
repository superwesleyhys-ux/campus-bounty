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
  await assert.rejects(f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{approved:true},key()),{code:'invalid_input'});
 }finally{await f.close();}
});

import {digest} from '../../backend/payments/amounts.mjs';
import {quoteAgreement,pay,onboard,acceptStage} from './transaction-ui-journeys.mjs';
async function configuration(f,x,change={}){const next={...x.config,...change};const v=(await f.owner.query('SELECT max(version)+1 v FROM campus.payment_product_configurations WHERE environment_id=$1',[x.env.id])).rows[0].v;await f.owner.query("INSERT INTO campus.payment_product_configurations VALUES($1,$2,$3,$4,$5,'Synthetic: explicit configuration update scenario')",[key(),x.env.id,v,next,digest(next)]);return next;}

test('missing configuration, immutable configuration equality, material repricing before quote, and old never-dispatched quote block',async()=>{
 const f=await isolated();try{
  await f.migrateThrough(22);const user=await f.user('No configuration yet');await assert.rejects(f.market.preparePaymentRecipient(user,{},key()),{code:'payments_unavailable'});
  const x=await configure(f),s=await agreement(f);
  const p=await f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key());await configuration(f,x);
  assert.equal((await f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key())).receipt.policyVersionId,p.receipt.policyVersionId,'identical configuration body does not churn policy');
  await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,fixedCents:120}});
  const repriced=await quoteAgreement(f,s);assert.equal(repriced.plan.current.plan.estimatedFeeCents,120);assert.equal(repriced.q.quote.chargeTotalCents,10066);
  const old=(await f.market.agreement(s.P,s.g.id)).transaction.terms[0];assert.equal(old.plan.lots[0].estimatedProcessorFeeCents,100,'historical allocation unchanged');
  await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,fixedCents:140}});
  const current=await f.market.participantPayment(s.P,'agreement',s.g.id);assert.equal(current.configurationChangeBlocker,'payment_configuration_changed_existing_intent');assert(!current.funding.allowedActions.includes('create_payment_attempt'));
  await assert.rejects(f.market.createPaymentAttempt(s.P,repriced.q.obligationId,repriced.attemptRequest,key()),{code:'payment_configuration_changed_existing_intent'});
  await assert.rejects(f.market.createAgreementPaymentQuote(s.P,s.g.id,repriced.quoteRequest,key()),{code:'payment_configuration_changed_existing_intent'});
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_attempts')).rows[0].n,0);
 }finally{await f.close();}
});

test('funded team settles exact separate members and current configuration fee supplement uses revision policy',async()=>{
 const f=await isolated();try{
  await f.migrateThrough(22);const x=await configure(f);const s=await pay(f,x,await quoteAgreement(f,await agreement(f,{team:true,stages:[5000,5000]})));
  for(const who of s.members)await onboard(f,x,who);
  await acceptStage(f,s,0);for(let i=0;i<6;i++)await x.worker.tick();
  const funding=await f.market.agreementFunding(s.P,s.g.id);assert(funding.payees.some(p=>p.transferredCents!=='0'));assert.equal(new Set(funding.payees.map(p=>p.memberId)).size,2);assert(funding.payees.some(p=>!p.releaseReady));for(const [who,amount] of [[s.C,2985],[s.M,1990]])assert.equal(funding.payees.filter(p=>p.memberId===who).reduce((n,p)=>n+Number(p.transferredCents),0),amount);
  const extra=await pay(f,x,await quoteAgreement(f,await agreement(f)),300);
  await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,fixedCents:120}});
  const prep=await f.market.preparePaymentTerms(extra.P,'fee_revision',extra.q.obligationId,{},key());
  const before=await f.market.paymentFeeRevision(extra.P,extra.q.obligationId);
  const revision=await f.market.proposePaymentFeeRevision(extra.P,extra.q.obligationId,{policyVersionId:prep.receipt.policyVersionId,policyDigest:prep.receipt.policyDigest,evidenceDigest:before.evidenceDigest},key());
  for(const who of [extra.P,...extra.members])await f.market.confirmPaymentFeeRevision(who,revision.receipt.revisionId,{digest:revision.receipt.digest},key());
  const supplement=await f.market.startPaymentFeeSupplement(extra.P,revision.receipt.revisionId,{digest:revision.receipt.digest,acceptedAmountCents:revision.current.plan.supplementalAmountCents},key());
  for(let i=0;i<5;i++)await x.worker.dispatch();
  const status=await f.market.paymentFeeRevision(extra.P,extra.q.obligationId);assert.equal(status.attempt.status,'requires_action');assert.equal(status.attempt.id,supplement.receipt.attemptId);
  const expected=(await f.store.workerTx(c=>c.query('SELECT campus.money_fee_supplement_expected($1,$2) AS result',[x.env.id,supplement.receipt.attemptId]))).rows[0].result;
  x.transport.pay(expected.sessionId,{fee:120,available:true});const object=await x.adapter.retrieveCheckoutAndPayment(expected.sessionId);const {createPosting}=await import('../../backend/payments/posting.mjs');await createPosting(f.store).payment(expected,object);for(let i=0;i<8;i++)await x.worker.tick();
  const settled=await f.market.paymentFeeRevision(extra.P,extra.q.obligationId);assert.equal(settled.state,'settled');assert.equal(settled.settledActualFeeCents,'420');assert.equal([...x.transport.refunds.values()].filter(r=>r.charge===object.charge.id).reduce((n,r)=>n+r.amount,0),6);
 }finally{await f.close();}
});

test('malformed or stale configuration fails closed; missing identity and unknown recipient operation stay explicit',async()=>{const f=await isolated();try{await f.migrateThrough(22);const x=await configure(f);const noIdentity=await f.user('Absent verified identity',{verified:false});await assert.rejects(f.market.preparePaymentRecipient(noIdentity,{},key()),{code:'verified_recipient_email_required'});const s=await agreement(f);
await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,rateBps:"1.5"}});await assert.rejects(f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key()),{code:'fee_estimate_outside_approved_scope'});
await configuration(f,x,{collectionProfileId:key()});await assert.rejects(f.market.preparePaymentTerms(s.P,'agreement',s.g.id,{},key()),{code:'payment_configuration_stale'});await configuration(f,x);
await f.market.preparePaymentRecipient(s.C,{},key());const created=await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:0},key());let creations=0;const create=x.transport.client.v2.core.accounts.create;x.transport.client.v2.core.accounts.create=async(...args)=>{creations++;await create(...args);throw Error('Synthetic response loss after recipient creation');};await x.worker.dispatch();const unknown=await f.market.paymentAccount(s.C);assert.equal(unknown.operation.status,'unknown');
await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,fixedCents:120}});const preserved=await f.market.preparePaymentRecipient(s.C,{},key());assert.equal(preserved.receipt.operationId,created.receipt.operationId);assert.equal(preserved.receipt.preserved,true);assert.equal((await f.market.onboardPaymentAccount(s.C,{expectedAccountRevision:0},key())).receipt.operationId,created.receipt.operationId);assert.equal(creations,1);
}finally{await f.close();}});

test('disabled runtime preserves status but advertises no new collection or recipient writes',async()=>{const f=await isolated();try{await f.migrateThrough(22);await configure(f);const s=await quoteAgreement(f,await agreement(f));const {createMarket}=await import('../../backend/modules/market.mjs');const disabled=createMarket(f.store,{paymentEnabled:false});const v=await disabled.participantPayment(s.P,'agreement',s.g.id);assert.equal(v.paymentEnabled,false);assert(!v.funding.allowedActions.includes('create_payment_attempt'));assert.deepEqual(v.feePlan.allowedActions,[]);assert.equal((await disabled.paymentAccount(s.C)).paymentEnabled,false);await assert.rejects(disabled.preparePaymentTerms(s.P,'agreement',s.g.id,{},key()),{code:'payments_unavailable'});assert.throws(()=>disabled.createPaymentAttempt(s.P,s.q.obligationId,s.attemptRequest,key()),{code:'payments_unavailable'});}finally{await f.close();}});

test('unknown initial collection retains exact operation and policy across a material configuration refresh',async()=>{const f=await isolated();try{await f.migrateThrough(22);const x=await configure(f),s=await quoteAgreement(f,await agreement(f));const requestKey=key(),created=await f.market.createPaymentAttempt(s.P,s.q.obligationId,s.attemptRequest,requestKey);const create=x.transport.client.checkout.sessions.create;let lost=false;x.transport.client.checkout.sessions.create=async(...args)=>{const r=await create(...args);if(!lost){lost=true;throw Error('Synthetic response loss after hosted session creation');}return r;};await x.worker.dispatch();const before=await f.market.paymentAttempt(s.P,created.receipt.attemptId);assert.equal(before.status,'unknown');await configuration(f,x,{feeEstimate:{...x.config.feeEstimate,fixedCents:140}});const recovered=await f.market.createPaymentAttempt(s.P,s.q.obligationId,s.attemptRequest,requestKey);assert.equal(recovered.receipt.operationId,created.receipt.operationId);assert.equal(recovered.receipt.attemptId,created.receipt.attemptId);const view=await f.market.participantPayment(s.P,'agreement',s.g.id);assert.equal(view.configurationChangeBlocker,'payment_configuration_changed_existing_intent');assert.equal(view.funding.activeAttempt.operationId,created.receipt.operationId);await new Promise(r=>setTimeout(r,2500));await x.worker.dispatch();const after=await f.market.paymentAttempt(s.P,created.receipt.attemptId);assert.equal(after.status,'requires_action');assert.equal(after.operationId,before.operationId);assert.equal(x.transport.sessions.size,1);assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_attempts')).rows[0].n,1);console.log(JSON.stringify({before,after,configurationBlocker:view.configurationChangeBlocker,sessions:1}));}finally{await f.close();}});
