// Independent negative regression: expects an order to reject if its quote has
// expired before it can acquire the inventory row lock. Does not alter source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../../tests/backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
const key=()=>randomUUID();
test('G7: quote expiry must be rechecked after waiting for inventory lock',async(t)=>{
 const f=await fixture(),store=createStore(f.urls),market=createMarket(store);
 t.after(async()=>{await f.owner.query('ROLLBACK');await store.close();await f.close();});
 const seller=await f.user('Seller'),buyer=await f.user('Buyer');
 const p=await market.publishProduct(seller,{title:'Expiry test',description:'Synthetic lock boundary',priceCents:1000,stock:1,deliveryMethods:['pickup']},key());
 const q=await market.quote(buyer,p.id,{quantity:1,deliveryMethod:'pickup'},key());
 // Accelerate the clock boundary using test-only fixture access. Public behavior
 // is the same when a normal ten-minute quote is submitted near its expiry.
 await f.owner.query("UPDATE campus.quotes SET expires_at=clock_timestamp()+interval '800 milliseconds' WHERE id=$1",[q.id]);
 await f.owner.query('BEGIN');
 await f.owner.query('SELECT id FROM campus.products WHERE id=$1 FOR UPDATE',[p.id]);
 const ownerPid=(await f.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const running=market.order(buyer,{quoteId:q.id},key()).then(value=>({value}),error=>({error}));
 let blocked=false;
 for(let i=0;i<100;i++) {
  // The non-superuser fixture cannot inspect another role's query/wait text.
  // Inspect actual blocking PIDs instead, without granting monitoring privileges.
  const r=await f.owner.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_app' AND $1=ANY(pg_blocking_pids(pid))",[ownerPid]);
  if(r.rowCount){blocked=true;break;}
  await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(blocked,'order must reach inventory lock while quote is valid');
 let proof;
 for(let i=0;i<150;i++) {
  proof=(await f.owner.query('SELECT expires_at,clock_timestamp() AS wall_time,expires_at<clock_timestamp() AS expired FROM campus.quotes WHERE id=$1',[q.id])).rows[0];
  if(proof.expired) break;
  await new Promise(r=>setTimeout(r,10));
 }
 assert.equal(proof.expired,true,'quote must expire while lock is held');
 await f.owner.query('COMMIT');
 const result=await running;
 const state=(await f.owner.query('SELECT (SELECT stock FROM campus.products WHERE id=$1) AS stock,(SELECT count(*)::int FROM campus.orders WHERE product_id=$1) AS orders',[p.id])).rows[0];
 console.log('G7 evidence:',JSON.stringify({quoteExpiredAt:proof.expires_at,wallTimeBeforeUnlock:proof.wall_time,result:result.error?{error:result.error.code}:{orderId:result.value.id,state:result.value.state},...state}));
 assert.equal(result.error?.code,'quote_expired','expected expired quote rejection at reservation boundary');
 assert.deepEqual(state,{stock:1,orders:0});
});
