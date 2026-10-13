import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../../tests/backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
const key = () => randomUUID();
const address = {name:'Synthetic Buyer',line1:'123 Example Street',city:'Test City',region:'CA',postalCode:'00000',country:'US'};
async function setup(t) {
 const f = await fixture(), store = createStore(f.urls), market = createMarket(store);
 t.after(async()=>{await store.close();await f.close();});
 const seller = await f.user('Seller'), buyer = await f.user('Buyer'), stranger = await f.user('Stranger');
 return {f,store,market,seller,buyer,stranger};
}
async function listing(market,seller,stock=1,deliveryMethods=['pickup','shipping']) {
 return market.publishProduct(seller,{title:'Synthetic test item',description:'Independent isolated fixture',priceCents:1000,shippingCents:125,stock,deliveryMethods},key());
}
async function quote(market,buyer,p,method='pickup',quantity=1) {return market.quote(buyer,p.id,{quantity,deliveryMethod:method},key());}
const rejects=(action,code)=>assert.rejects(action,e=>e.code===code);

test('G1: 24 buyers race for seven final units; exactly seven orders exist',async(t)=>{
 const {f,market,seller}=await setup(t),p=await listing(market,seller,7);
 const buyers=await Promise.all(Array.from({length:24},(_,i)=>f.user('Race '+i)));
 const quotes=await Promise.all(buyers.map(b=>quote(market,b,p)));
 const results=await Promise.allSettled(quotes.map((q,i)=>market.order(buyers[i],{quoteId:q.id},key())));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,7);
 assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='out_of_stock').length,17);
 const proof=(await f.owner.query('SELECT (SELECT stock FROM campus.products WHERE id=$1) AS stock,(SELECT count(*)::int FROM campus.orders WHERE product_id=$1) AS orders',[p.id])).rows[0];
 assert.deepEqual(proof,{stock:0,orders:7});
 console.log('G1 evidence:',JSON.stringify(proof));
});

test('G2: concurrent same quote with different keys consumes stock exactly once; address changes conflict',async(t)=>{
 const {f,market,seller,buyer}=await setup(t),p=await listing(market,seller,10),q=await quote(market,buyer,p,'shipping');
 const body={quoteId:q.id,shippingAddress:address};
 const results=await Promise.all(Array.from({length:20},()=>market.order(buyer,body,key())));
 assert.equal(new Set(results.map(o=>o.id)).size,1);
 assert.equal((await f.owner.query('SELECT stock FROM campus.products WHERE id=$1',[p.id])).rows[0].stock,9);
 await rejects(market.order(buyer,{...body,shippingAddress:{...address,line1:'Different address'}},key()),'quote_consumed');
 const k=key();await market.order(buyer,body,k);
 await rejects(market.order(buyer,{...body,shippingAddress:{...address,line1:'Different address'}},k),'idempotency_conflict');
 // Expiry prevents new reservations, but must not invalidate a completed retry.
 await f.owner.query("UPDATE campus.quotes SET expires_at=now()-interval '1 second' WHERE id=$1",[q.id]);
 assert.equal((await market.order(buyer,body,key())).id,results[0].id);
 assert.equal((await market.order(buyer,body,k)).id,results[0].id);
 assert.equal((await f.owner.query('SELECT stock FROM campus.products WHERE id=$1',[p.id])).rows[0].stock,9);
});

test('G3: expired/stale/foreign quotes and invalid delivery inputs reject without stock loss',async(t)=>{
 const {f,market,seller,buyer,stranger}=await setup(t),p=await listing(market,seller,10),q=await quote(market,buyer,p,'shipping');
 await rejects(market.order(stranger,{quoteId:q.id,shippingAddress:address},key()),'not_found');
 await rejects(market.order(seller,{quoteId:q.id,shippingAddress:address},key()),'not_found');
 await rejects(market.order(buyer,{quoteId:q.id},key()),'shipping_address_required');
 await assert.rejects(market.order(buyer,{quoteId:q.id,shippingAddress:{...address,country:'CA'}},key()));
 await f.owner.query("UPDATE campus.quotes SET expires_at=now()-interval '1 second' WHERE id=$1",[q.id]);
 await rejects(market.order(buyer,{quoteId:q.id,shippingAddress:address},key()),'quote_expired');
 const qp=await quote(market,buyer,p);
 await rejects(market.order(buyer,{quoteId:qp.id,shippingAddress:address},key()),'unexpected_address');
 await f.owner.query('UPDATE campus.products SET revision=revision+1 WHERE id=$1',[p.id]);
 await rejects(market.order(buyer,{quoteId:qp.id},key()),'stale_quote');
 const pickupOnly=await listing(market,seller,1,['pickup']);
 await rejects(quote(market,buyer,pickupOnly,'shipping'),'delivery_unavailable');
 assert.equal((await f.owner.query('SELECT stock FROM campus.products WHERE id=$1',[p.id])).rows[0].stock,10);
});

test('G4: order address and messages visible only to buyer/seller; list does not expose address',async(t)=>{
 const {store,market,seller,buyer,stranger}=await setup(t),p=await listing(market,seller),q=await quote(market,buyer,p,'shipping');
 const o=await market.order(buyer,{quoteId:q.id,shippingAddress:address},key());
 for (const actor of [buyer,seller]) assert.deepEqual((await market.getOrder(actor,o.id)).shipping_address,address);
 await rejects(market.getOrder(stranger,o.id),'not_found');
 assert.deepEqual(await market.orders(stranger),[]);
 assert.equal(Object.hasOwn((await market.orders(buyer))[0],'shipping_address'),false);
 assert.equal((await store.as(stranger,c=>c.query('SELECT * FROM campus.orders WHERE id=$1',[o.id]))).rowCount,0);
 await market.sendMessage(buyer,{orderId:o.id,body:'private buyer message'},key());
 await market.sendMessage(seller,{orderId:o.id,body:'private seller message'},key());
 for(const actor of [buyer,seller]) assert.equal((await market.messages(actor,{orderId:o.id})).length,2);
 await rejects(market.messages(stranger,{orderId:o.id}),'not_found');
 await rejects(market.sendMessage(stranger,{orderId:o.id,body:'unauthorized message'},key()),'not_found');
 assert.equal((await store.as(stranger,c=>c.query('SELECT * FROM campus.messages WHERE order_id=$1',[o.id]))).rowCount,0);
});

test('G5: shipping and pickup enforce payment, proper fulfillment actor/data, buyer receipt and immutable terms',async(t)=>{
 const {f,market,seller,buyer,stranger}=await setup(t),p=await listing(market,seller,2);
 for (const method of ['shipping','pickup']) {
  const q=await quote(market,buyer,p,method),o=await market.order(buyer,{quoteId:q.id,...(method==='shipping'?{shippingAddress:address}:{})},key());
  const fulfillment=method==='shipping'?{carrier:'Synthetic carrier',trackingNumber:'LOCAL-0001'}:{};
  await rejects(market.fulfillOrder(seller,o.id,fulfillment,key()),'payment_required');
  await rejects(market.completeOrder(buyer,o.id,{},key()),'invalid_state');
  await f.owner.query("UPDATE campus.orders SET state='paid' WHERE id=$1",[o.id]);
  await rejects(market.fulfillOrder(buyer,o.id,fulfillment,key()),'not_seller');
  await rejects(market.fulfillOrder(stranger,o.id,fulfillment,key()),'not_found');
  await rejects(market.fulfillOrder(seller,o.id,method==='shipping'?{}:{carrier:'X',trackingNumber:'Y'},key()),method==='shipping'?'tracking_required':'unexpected_tracking');
  const fulfilled=await market.fulfillOrder(seller,o.id,fulfillment,key());
  assert.equal(fulfilled.state,method==='shipping'?'shipped':'ready_for_pickup');
  await rejects(market.completeOrder(seller,o.id,{},key()),'not_buyer');
  await rejects(market.completeOrder(stranger,o.id,{},key()),'not_found');
  assert.equal((await market.completeOrder(buyer,o.id,{},key())).state,'completed');
  await assert.rejects(f.owner.query("UPDATE campus.orders SET total_cents=total_cents+1 WHERE id=$1",[o.id]),e=>e.code==='23514');
 }
});

test('G6: ten concurrent expiry workers release 12 unpaid reservations once and do not release paid stock',async(t)=>{
 const {f,market,seller,buyer}=await setup(t),p=await listing(market,seller,13);
 const qs=await Promise.all(Array.from({length:13},()=>quote(market,buyer,p)));
 const orders=await Promise.all(qs.map(q=>market.order(buyer,{quoteId:q.id},key())));
 await f.owner.query("UPDATE campus.orders SET reserved_until=now()-interval '1 second' WHERE product_id=$1",[p.id]);
 await f.owner.query("UPDATE campus.orders SET state='paid' WHERE id=$1",[orders[0].id]);
 const counts=await Promise.all(Array.from({length:10},()=>market.expireReservations()));
 assert.equal(counts.reduce((a,b)=>a+b,0),12);
 assert.equal(await market.expireReservations(),0);
 const proof=(await f.owner.query("SELECT (SELECT stock FROM campus.products WHERE id=$1) AS stock,(SELECT count(*)::int FROM campus.orders WHERE product_id=$1 AND state='expired') AS expired,(SELECT count(*)::int FROM campus.events WHERE kind='order.expired') AS events",[p.id])).rows[0];
 assert.deepEqual(proof,{stock:12,expired:12,events:12});
 console.log('G6 evidence:',JSON.stringify(proof));
});
