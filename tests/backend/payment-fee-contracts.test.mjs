import test from 'node:test';import assert from 'node:assert/strict';
import {isolated,controlledMoneyClock,key} from './payment-money-fixture.mjs';import {paymentFixture} from './payment-fix1-fixture.mjs';
import {parseFeeCsv,decimalCents} from '../../backend/payments/fee-reports.mjs';
test('bounded fee pagination ingests20 distinct cash debits; unmatched positive correction remains recorded once and held; synthetic profiles reject live scope',async()=>{
 const f=await isolated(0);try{
  await f.migrateThrough(20);const clock=await controlledMoneyClock(f),x=await paymentFixture(f,clock);
  for(let n=0;n<20;n++){const id='txn_page_'+n;x.transport.balances.set(id,{id,type:'stripe_fee',currency:'usd',amount:-1,fee:0,net:-1,status:'available'});}
  const requests=[],list=x.transport.client.balanceTransactions.list;x.transport.client.balanceTransactions.list=async p=>{requests.push(p);return list(p);};
  await x.worker.fees();assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,16);await clock.advance(31000);await x.worker.fees();assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,20);assert.equal(requests[1].starting_after,'txn_page_15');assert.ok(requests.every(p=>p.limit===16));
  x.transport.balances.set('txn_credit',{id:'txn_credit',type:'stripe_fee',currency:'usd',amount:10,fee:0,net:10,status:'available'});for(let n=0;n<4;n++){await clock.advance(61000);await x.worker.fees();}
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_fee_cash_facts')).rows[0].n,21);assert.equal((await f.owner.query("SELECT count(*)::int n FROM campus.payment_fee_evidence_conflicts WHERE identity='fee_credit_attribution_unresolved:txn_credit'")).rows[0].n,1);assert.equal((await f.owner.query("SELECT sum(debit-credit)::text n FROM campus.ledger_lines WHERE account='cash'")).rows[0].n,'-10');
  const live=key();await f.owner.query("INSERT INTO campus.payment_environments VALUES($1,'stripe','live','acct_disabled_live_fixture','Synthetic: negative scope only','2026-09-30.endive','23.0.0','http://127.0.0.1:3999',false)",[live]);
  await assert.rejects(f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,1,'acct_disabled_live_fixture','inline',$2,'Synthetic: forbidden live closure')",[live,JSON.stringify({kind:'synthetic_original_charge_balance_v1'})]),{message:'synthetic_profile_scope_mismatch'});
  await assert.rejects(f.owner.query("INSERT INTO campus.payment_billing_profiles(environment_id,version,platform_account_id,billing_mode,contract,provenance) VALUES($1,1,'acct_disabled_live_fixture','inline',$2,'Synthetic: cannot stand in for verified account billing')",[live,JSON.stringify({kind:'stripe_standard_inline_charge_balance_v1',pricingModel:'standard_non_ic_plus',source:'https://docs.stripe.com/expand/use-cases',accountEvidenceDigest:'a'.repeat(64),accountEvidenceRef:'Synthetic'})]),{message:'billing_profile_evidence_required'});
  assert.equal((await f.owner.query('SELECT count(*)::int n FROM campus.payment_billing_profiles WHERE environment_id=$1',[live])).rows[0].n,0);
  assert.ok((await f.owner.query('SELECT count(*)::int n FROM campus.payment_environment_effect_history')).rows[0].n>=22);
 }finally{await f.close();}
});
test('fee report amounts and semantic identity are exact; malformed, ambiguous, foreign-account and tax rows do not masquerade as duplicate charges',()=>{
 assert.equal(decimalCents('0.01'),1);assert.equal(decimalCents('3.30'),330);assert.throws(()=>decimalCents('1.001'));assert.throws(()=>decimalCents('1e2'));
 const header='balance_transaction_id,fee_transaction_id,incurred_by,incurred_by_type,amount,tax,currency,product,feature_name,settled_via,account_id\n',row='txn_1,fee_1,ch_1,charge,3.00,0.20,usd,Payments,Processing,balance,acct_one\n';
 const parsed=parseFeeCsv(header+row,'acct_one');assert.equal(parsed[0].taxCents,20);assert.throws(()=>parseFeeCsv(header+row+row,'acct_one'),/ambiguous_duplicate/);assert.throws(()=>parseFeeCsv(header+row,'acct_other'),/provider_scope/);assert.throws(()=>parseFeeCsv(header+row.replace('3.00','"3.00'),'acct_one'),/csv_invalid/);
});
