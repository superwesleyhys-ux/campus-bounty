import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as key } from 'node:crypto';
import pg from 'pg';
import { fixture } from '../../backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
import { notificationQuery } from '../../../backend/modules/notifications.mjs';

// Independent reviewer-authored synthetic fixture. No preview or shared-role changes.
const f = await fixture();
for (const value of Object.values(f.urls)) {
  const u = new URL(value);
  assert.equal(u.hostname, '127.0.0.1');
  assert.match(u.pathname, /^\/campus_test_[a-f0-9]{32}$/);
}
const store = createStore(f.urls), market = createMarket(store);
test.after(async () => { await store.close(); await f.close(); });
const failCode = code => error => error.code === code;
const rev = t => ({ expectedRevision: t.revision });
const context = { purpose:'Independent synthetic research', activities:'Review samples', timeCommitment:'One hour', projectContext:'Do not copy PRIVATE_CONTEXT' };
async function users(n) { const a=[]; for(let i=0;i<n;i++) a.push(await f.user(`Independent ${i}`)); return a; }
async function signed() {
 const [owner, worker, outsider] = await users(3);
 const task = await market.publishTask(owner, {title:'PRIVATE_TASK',category:'Research',description:'PRIVATE_DESCRIPTION',rewardCents:300,milestones:[1,2,3].map(i=>({title:`Phase ${i}`,deliverable:'PRIVATE_DELIVERABLE',amountCents:100}))}, key());
 const application = await market.apply(worker,task.id,{proposal:'PRIVATE_PROPOSAL'},key());
 await market.inviteApplicant(owner,application.id,{},key());
 const agreement = await market.acceptInvitation(worker,application.id,{},key());
 return {owner,worker,outsider,task,application,agreement};
}
const inbox = (id,q={}) => market.notifications(id,{limit:'50',...q});
async function message(s,body='PRIVATE_MESSAGE') { return market.sendMessage(s.worker,{agreementId:s.agreement.id,body},key()); }
async function waitForLock(pid) {
 const deadline=Date.now()+2000;
 while(Date.now()<deadline) {
  const r=await f.owner.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]);
  if(r.rows[0]?.wait_event_type==='Lock') return;
  await new Promise(r=>setTimeout(r,10));
 }
 throw Error('Expected transaction lock was not observed');
}

test('an existing read receipt must re-redact a revoked team target and recover visibility after a new invitation', async()=>{
 const [captain,invitee,outsider]=await users(3);
 let team=await market.createTeam(captain,{name:'PRIVATE_TEAM',context},key());
 team=await market.inviteMember(captain,team.id,{...rev(team),userId:invitee},key());
 const original=(await inbox(invitee)).items[0], readKey=key();
 const read=await market.readNotification(invitee,original.id,{},readKey);
 assert.equal(read.target.id,team.id); assert.equal(read.contextLabel,'PRIVATE_TEAM'); assert.equal(read.target.contextLabel,undefined);
 assert.equal(original.messageContext,null); assert.equal(read.messageContext,null);
 team=await market.revokeInvitation(captain,team.id,invitee,rev(team),key());
 const replay=await market.readNotification(invitee,original.id,{},readKey);
 assert.equal(replay.readAt,read.readAt); assert.equal(replay.target,null); assert.equal(replay.targetAvailable,false);
 assert.equal(replay.contextLabel,null); assert.equal(replay.title,'Activity update'); assert.ok(!JSON.stringify(replay).includes(team.id));
 assert.equal(replay.messageContext,null);
 assert.equal((await inbox(invitee)).items.filter(n=>n.target!==null).length,0);
 assert.ok((await inbox(invitee)).items.every(n=>n.messageContext===null));
 await assert.rejects(market.readNotification(outsider,original.id,{},readKey),failCode('not_found'));
 team=await market.inviteMember(captain,team.id,{...rev(team),userId:invitee},key());
 assert.equal((await market.readNotification(invitee,original.id,{},readKey)).target.id,team.id);
 assert.equal((await inbox(invitee)).items.filter(n=>n.kind==='team.invite').length,2);
});

test('queued SQL acknowledgement rechecks a concurrently committed account lock',async()=>{
 const s=await signed(), n=(await inbox(s.owner)).items[0];
 const client=new pg.Client({connectionString:f.urls.app}); await client.connect();
 const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await f.owner.query('BEGIN');
 try {
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[s.owner]);
  await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='4s'");
  await client.query("SELECT set_config('campus.actor_id',$1,true)",[s.owner]);
  const pending=client.query('SELECT campus.mark_notification_read($1)',[n.id]).then(()=>({ok:true}),error=>({error}));
  await waitForLock(pid); await f.owner.query('COMMIT');
  const result=await pending; assert.equal(result.error?.code,'42501');
  await client.query('ROLLBACK');
  assert.equal((await f.owner.query('SELECT read_at FROM campus.notifications WHERE id=$1',[n.id])).rows[0].read_at,null);
  assert.equal((await store.as(s.owner,c=>c.query('SELECT * FROM campus.notifications'))).rowCount,0);
 } finally { await f.owner.query('ROLLBACK'); await client.query('ROLLBACK'); await client.end(); }
});

test('two acknowledgement keys and a concurrent arrival affect only the selected notification',async()=>{
 const s=await signed(); await message(s); const before=await inbox(s.owner), n=before.items[0];
 const [a,b]=await Promise.all([market.readNotification(s.owner,n.id,{},key()),market.readNotification(s.owner,n.id,{},key()),message(s,'PRIVATE_NEW_ARRIVAL')]);
 assert.equal(a.readAt,b.readAt);
 const after=await inbox(s.owner); assert.equal(after.unreadCount,before.unreadCount);
 assert.equal(after.items.filter(x=>x.readAt).length,1); assert.equal(after.items.find(x=>x.readAt).id,n.id);
 assert.ok(after.items.some(x=>!before.items.some(y=>y.id===x.id)&&x.readAt===null));
});

test('foreign cursors never cross recipient RLS and exact timestamp pagination does not skip surviving rows',async()=>{
 const s=await signed(); for(let i=0;i<7;i++) await message(s);
 const before=(await inbox(s.owner)).items, first=await inbox(s.owner,{limit:'2',unread:'true'});
 await market.readNotification(s.owner,before[3].id,{},key());
 await message(s,'PRIVATE_BETWEEN_PAGES');
 let cursor=first.nextCursor; const rest=[];
 while(cursor) {const page=await inbox(s.owner,{limit:'2',unread:'true',cursor});rest.push(...page.items);cursor=page.nextCursor;}
 assert.deepEqual(rest.map(x=>x.id),before.slice(2).filter(x=>x.id!==before[3].id).map(x=>x.id));
 assert.deepEqual((await inbox(s.outsider,{unread:'true',cursor:first.nextCursor})).items,[]);
 // Only authorized read-time contextLabel and messageContext may contain private text; all old fields and raw storage remain checked.
 const rendered=await inbox(s.owner);
 assert.ok(!JSON.stringify({...rendered,items:rendered.items.map(({contextLabel,messageContext,...item})=>item)}).includes('PRIVATE_'));
 assert.ok(rendered.items.filter(x=>x.kind!=='message.received').every(x=>x.messageContext===null));
 assert.ok(rendered.items.every(x=>x.contextLabel==='PRIVATE_TASK'));
 assert.ok(rendered.items.every(x=>!('contextLabel' in x.target)));
 const raw=(await f.owner.query('SELECT * FROM campus.notifications WHERE recipient_id=$1',[s.owner])).rows;
 assert.ok(!JSON.stringify(raw).includes('PRIVATE_'));
});

test('all notification helper privileges are narrow and rolled-back read state leaves no receipt',async()=>{
 const s=await signed(), n=(await inbox(s.owner)).items[0];
 const functions=(await f.owner.query("SELECT p.oid::regprocedure::text AS signature, has_function_privilege('campus_app',p.oid,'EXECUTE') AS app, has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth, has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='campus' AND (p.proname LIKE '%notification%' OR p.proname LIKE 'notify_%')")).rows;
 assert.ok(functions.length>=12);
 for(const fn of functions) {
  assert.equal(fn.auth,false,fn.signature); assert.equal(fn.worker,false,fn.signature);
  assert.equal(fn.app,/campus\.(notification_target|mark_notification_read|notification_work_detail)\(/.test(fn.signature),fn.signature);
 }
 await assert.rejects(store.as(s.owner,async c=>{await c.query('SELECT campus.mark_notification_read($1)',[n.id]);throw Error('deliberate rollback');}),/deliberate rollback/);
 assert.equal((await inbox(s.owner)).items.find(x=>x.id===n.id).readAt,null);
 const before=(await inbox(s.owner)).items.length;
 await assert.rejects(store.as(s.worker,async c=>{await c.query("INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'PRIVATE_ABORT')",[s.worker,s.agreement.id]);throw Error('deliberate rollback');}),/deliberate rollback/);
 assert.equal((await inbox(s.owner)).items.length,before);
});

test('expired membership omits catalog task link while retaining permitted agreement history and exact empty overview',async()=>{
 const s=await signed();
 await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[s.owner]);
 const notes=(await inbox(s.owner)).items;
 assert.ok(notes.find(x=>x.kind==='application.received').target);
 assert.equal(notes.find(x=>x.kind==='application.received').target.taskId,undefined);
 assert.equal(notes.find(x=>x.kind==='application.received').contextLabel,null);
 assert.equal(notes.find(x=>x.kind==='application.accepted').target.id,s.agreement.id);
 assert.equal(notes.find(x=>x.kind==='application.accepted').contextLabel,'PRIVATE_TASK');
 assert.deepEqual((await market.agreements(s.owner))[0].milestone_counts,{pending:3,submitted:0,revision_requested:0,accepted:0,total:3});
 assert.deepEqual(await market.agreements(s.outsider),[]);
 assert.equal((await market.task(s.outsider,s.task.id)).related_agreement,null);
});

test('strict query boundaries reject malformed dates, arrays, unknown keys, coercion and cursor filter changes',()=>{
 for(const input of [{limit:'01'},{limit:'+1'},{limit:'1e1'},{limit:''},{limit:['1']},{unread:true},{unread:'TRUE'},{cursor:'='},{cursor:' '},{unknown:'x'}])
  assert.throws(()=>notificationQuery(input),failCode('invalid_input'));
 for(const createdAt of ['2026-02-29T00:00:00.000000Z','2026-04-31T00:00:00.000000Z','2026-01-01T24:00:00.000000Z','2026-01-01T00:00:00.000Z','0000-01-01T00:00:00.000000Z']) {
  const cursor=Buffer.from(JSON.stringify({createdAt,id:key(),unread:false})).toString('base64url');
  assert.throws(()=>notificationQuery({cursor}),failCode('invalid_input'));
 }
 assert.equal(notificationQuery({limit:'50'}).limit,50);
});

test('signed-work notices use frozen confirmed members after team departure and exclude a later accepted member',async()=>{
 const [publisher,captain,original,later]=await users(4);
 let team=await market.createTeam(captain,{name:'Independent frozen roster',context},key());
 team=await market.inviteMember(captain,team.id,{...rev(team),userId:original},key());
 team=await market.acceptMembership(original,team.id,rev(team),key());
 const task=await market.publishTask(publisher,{title:'Independent signed task',category:'Research',description:'PRIVATE_RESEARCH',rewardCents:100,milestones:[{title:'Stage',amountCents:100,deliverable:'PRIVATE_DELIVERABLE'}]},key());
 const app=await market.apply(captain,task.id,{proposal:'PRIVATE_PROPOSAL',teamId:team.id},key());
 assert.equal((await inbox(original)).items.filter(n=>n.kind==='application.consent_requested').length,1);
 await assert.rejects(market.inviteApplicant(publisher,app.id,{},key()),failCode('team_consent_required'));
 assert.equal((await inbox(original)).items.filter(n=>n.kind==='application.invited').length,0);
 await market.consentApplication(original,app.id,{},key());
 await market.inviteApplicant(publisher,app.id,{},key());
 const agreement=await market.acceptInvitation(captain,app.id,{},key());
 assert.equal((await inbox(original)).items.filter(n=>n.kind==='application.accepted').length,1);
 assert.equal((await inbox(captain)).items.filter(n=>n.kind==='application.accepted').length,0);
 team=await market.leaveTeam(original,team.id,rev(team),key());
 team=await market.inviteMember(captain,team.id,{...rev(team),userId:later},key());
 team=await market.acceptMembership(later,team.id,rev(team),key());
 const msgKey=key(), body={agreementId:agreement.id,body:'PRIVATE_FROZEN_MESSAGE'};
 await Promise.all([market.sendMessage(publisher,body,msgKey),market.sendMessage(publisher,body,msgKey)]);
 assert.equal((await inbox(original)).items.filter(n=>n.kind==='message.received').length,1);
 assert.equal((await inbox(later)).items.filter(n=>n.kind==='message.received').length,0);
 assert.equal((await inbox(publisher)).items.filter(n=>n.kind==='message.received').length,0);
 assert.equal((await inbox(original)).items.find(n=>n.kind==='message.received').target.id,agreement.id);
 assert.equal((await market.task(original,task.id)).related_agreement.id,agreement.id);
 assert.equal((await market.task(later,task.id)).related_agreement,null);
});


test('context labels and message previews are authorized read-time fields, excluded from raw storage and SQL outsider access',async()=>{
 const s=await signed(), sent=await message(s,'PRIVATE_SENSITIVE_BODY');
 const note=(await inbox(s.owner)).items.find(x=>x.kind==='message.received');
 assert.equal(note.contextLabel,'PRIVATE_TASK');
 assert.deepEqual(note.target,{type:'agreement',id:s.agreement.id});
 const {contextLabel,messageContext,...oldFields}=note;
 assert.ok(!JSON.stringify(oldFields).includes('PRIVATE_SENSITIVE_BODY'));
 const createdAt=(await f.owner.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_time FROM campus.messages WHERE id=$1`,[sent.id])).rows[0].exact_time;
 const expectedContext={messageId:sent.id,createdAt,author:{id:s.worker,displayName:'Independent 1',role:'captain'},preview:'PRIVATE_SENSITIVE_BODY',truncated:false};
 assert.deepEqual(messageContext,expectedContext);
 const acknowledged=await market.readNotification(s.owner,note.id,{},key());
 assert.deepEqual(acknowledged.messageContext,expectedContext);
 const {contextLabel:readLabel,messageContext:readContext,...readOldFields}=acknowledged;
 assert.ok(!JSON.stringify(readOldFields).includes('PRIVATE_'));
 for(const [kind,id] of [['agreement',s.agreement.id],['application',s.application.id]]) {
  assert.equal((await store.as(s.outsider,c=>c.query('SELECT campus.notification_target($1,$2) AS target',[kind,id]))).rows[0].target,null);
 }
 const [seller,buyer,outsider]=await users(3);
 const title='界'.repeat(160);
 const product=await market.publishProduct(seller,{title,description:'PRIVATE_PRODUCT_BODY',priceCents:100,stock:1,deliveryMethods:['pickup'],shippingCents:0},key());
 const quote=await market.quote(buyer,product.id,{quantity:1,deliveryMethod:'pickup'},key());
 const order=await market.order(buyer,{quoteId:quote.id},key());
 const orderNote=(await inbox(seller)).items[0];
 assert.equal(orderNote.contextLabel,title); assert.equal([...orderNote.contextLabel].length,160);
 assert.deepEqual(orderNote.target,{type:'order',id:order.id});
 assert.equal(orderNote.messageContext,null);
 assert.equal((await store.as(outsider,c=>c.query("SELECT campus.notification_target('order',$1) AS target",[order.id]))).rows[0].target,null);
 assert.ok(!JSON.stringify((await f.owner.query('SELECT * FROM campus.notifications WHERE recipient_id=ANY($1::uuid[])',[[s.owner,seller]])).rows).includes('PRIVATE_'));
 assert.ok(!JSON.stringify((await f.owner.query('SELECT * FROM campus.notifications WHERE recipient_id=$1',[seller])).rows).includes(title));
 await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[s.owner]);
 assert.equal((await store.as(s.owner,c=>c.query("SELECT campus.notification_target('agreement',$1) AS target",[s.agreement.id]))).rows[0].target,null);
});
