// Independent requirement-driven Round 8 tests. No implementation test imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as key } from 'node:crypto';
import pg from 'pg';
import { fixture } from '../../backend/fixture.mjs';
import { localConfig, connectionString } from '../../../scripts/backend-local.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
import { conversationQuery, conversationHttpQuery } from '../../../backend/modules/conversations.mjs';

// Check the fixture factory's actual connection source before it creates/writes a DB.
assert.equal(new URL(connectionString(localConfig(),'migrator')).hostname,'127.0.0.1');
const f=await fixture();
for(const value of Object.values(f.urls)) { const u=new URL(value); assert.equal(u.hostname,'127.0.0.1'); assert.match(u.pathname,/^\/campus_test_[a-f0-9]{32}$/); }
const store=createStore(f.urls), market=createMarket(store);
test.after(async()=>{ await store.close(); await f.close(); });
const code=c=>e=>e.code===c;
const context={purpose:'Independent fixture',activities:'Synthetic collaboration',timeCommitment:'One hour',projectContext:'No private live data'};
const rev=t=>({expectedRevision:t.revision});
const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const decode=s=>JSON.parse(Buffer.from(s,'base64url').toString());
async function signed(teamMode=false) {
 const owner=await f.user('Publisher'),worker=await f.user('Captain'),outsider=await f.user('OUTSIDE_SECRET');
 let team,member;
 if(teamMode) { member=await f.user('Original signer');team=await market.createTeam(worker,{name:'Synthetic team',context},key());team=await market.inviteMember(worker,team.id,{...rev(team),userId:member},key());team=await market.acceptMembership(member,team.id,rev(team),key()); }
 const task=await market.publishTask(owner,{title:'Independent signed project',category:'Research',description:'Private task content',rewardCents:200,milestones:[{title:'First signed stage',deliverable:'Private deliverable A',amountCents:100},{title:'Second signed stage',deliverable:'Private deliverable B',amountCents:100}]},key());
 const app=await market.apply(worker,task.id,{proposal:'Private proposal',...(team?{teamId:team.id}:{})},key());
 if(member) await market.consentApplication(member,app.id,{},key());
 await market.inviteApplicant(owner,app.id,{},key());const agreement=await market.acceptInvitation(worker,app.id,{},key());
 return {owner,worker,outsider,member,team,task,agreement,scope:{agreementId:agreement.id},type:'agreement'};
}
async function ordered() {
 const owner=await f.user('Seller'),worker=await f.user('Buyer'),outsider=await f.user('OUTSIDE_SECRET');
 const product=await market.publishProduct(owner,{title:'Synthetic object',description:'Private listing',priceCents:100,stock:2,deliveryMethods:['pickup'],shippingCents:0},key());
 const quote=await market.quote(worker,product.id,{quantity:1,deliveryMethod:'pickup'},key());
 const order=await market.order(worker,{quoteId:quote.id},key());
 return {owner,worker,outsider,order,scope:{orderId:order.id},type:'order'};
}
const inbox=async actor=>(await market.notifications(actor,{limit:'50'})).items;
const count=async(table,where='',params=[]) => (await f.owner.query(`SELECT count(*)::int AS n FROM campus.${table} ${where}`,params)).rows[0].n;
async function seedMessage(actor,sql,params) {
 // Privileged synthetic history insertion still satisfies the new current-send trigger;
 // use transaction-local authorized actor, never disable triggers or grant app privileges.
 await f.owner.query('BEGIN');
 try {await f.owner.query("SELECT set_config('campus.actor_id',$1,true)",[actor]);const r=await f.owner.query(sql,params);await f.owner.query('COMMIT');return r;}
 catch(e){await f.owner.query('ROLLBACK');throw e;}
}
async function waitBlockedBy(blockerPid) {
 const end=Date.now()+2000;
 while(Date.now()<end) {const r=await f.owner.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blockerPid]);if(r.rowCount)return r.rows[0].pid;await new Promise(r=>setTimeout(r,10));}
 throw Error('Expected actual PostgreSQL wait not observed');
}

test('frozen signers survive departure; later joiners are excluded; current labels do not expose profiles',async()=>{
 const s=await signed(true),later=await f.user('Later member');
 let team=await market.leaveTeam(s.member,s.team.id,rev(s.team),key());
 team=await market.inviteMember(s.worker,team.id,{...rev(team),userId:later},key());await market.acceptMembership(later,team.id,rev(team),key());
 await market.sendMessage(s.member,{...s.scope,body:'Message from departed signer'},key());
 await f.owner.query("UPDATE campus.users SET display_name='Edited signer label',bio='BIO_SECRET' WHERE id=$1",[s.member]);
 let page=await market.conversation(s.member,s.scope);
 assert.deepEqual(new Map(page.participants.map(p=>[p.id,p.role])),new Map([[s.owner,'publisher'],[s.worker,'captain'],[s.member,'participant']]));
 assert.deepEqual(page.items[0].author,{id:s.member,displayName:'Edited signer label',role:'participant'});
 for(const p of page.participants)assert.deepEqual(Object.keys(p).sort(),['displayName','id','role']);
 assert.ok(!JSON.stringify(page).match(/BIO_SECRET|OUTSIDE_SECRET|campus\.example\.test|institution_id|valid_until|Later member/));
 for(const actor of [later,s.outsider]) {await assert.rejects(market.conversation(actor,s.scope),code('not_found'));await assert.rejects(market.conversationParticipants(actor,s.scope),code('not_found'));}
 for(const status of ['restricted','active']) {await f.owner.query('UPDATE campus.users SET account_status=$2 WHERE id=$1',[s.member,status]);await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[s.member]);assert.equal((await market.conversation(s.member,s.scope)).items.length,1);}
 await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[s.member]);
 await assert.rejects(market.conversation(s.member,s.scope),code('account_locked'));
 assert.equal((await store.as(s.member,c=>c.query("SELECT * FROM campus.conversation_people('agreement',$1)",[s.agreement.id]))).rowCount,0);
});

test('bounded participant pages expose all 105 signed people and label an author outside the initial 100',async()=>{
 const s=await signed();
 // Owner seeds synthetic frozen agreement_members; does not impersonate app roster mutation.
 const extras=Array.from({length:103},()=>key());
 await f.owner.query("INSERT INTO campus.users(id,display_name,bio) SELECT x,'Extra '||x::text,'PRIVATE_PROFILE' FROM unnest($1::uuid[]) x",[extras]);
 await f.owner.query('INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT $1,x FROM unnest($2::uuid[]) x',[s.agreement.id,extras]);
 const expected=[s.owner,s.worker,...extras].sort(),last=expected.at(-1);
 await seedMessage(s.owner,"INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'LAST_AUTHOR')",[last,s.agreement.id]);
 // Historical out-of-roster message must stay content-compatible but never resolve a broad profile.
 await seedMessage(s.owner,"INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'LEGACY_OUTSIDER')",[s.outsider,s.agreement.id]);
 const page=await market.conversation(s.owner,s.scope);assert.equal(page.participants.length,100);assert.equal(page.participantCount,105);assert.equal(page.participantLimit,100);assert.ok(page.nextParticipantCursor);
 assert.deepEqual(page.participants.map(x=>x.id),expected.slice(0,100));
 assert.equal(page.items.find(x=>x.body==='LAST_AUTHOR').author.id,last);assert.equal(page.items.find(x=>x.body==='LEGACY_OUTSIDER').author,null);
 const got=[...page.participants];let cursor=page.nextParticipantCursor;
 await f.owner.query("UPDATE campus.users SET display_name='Renamed between pages' WHERE id=$1",[last]);
 while(cursor) {const p=await market.conversationParticipants(s.worker,{...s.scope,limit:'2',cursor});assert.equal(p.participantCount,105);got.push(...p.items);cursor=p.nextCursor;}
 assert.deepEqual(got.map(x=>x.id),expected);assert.equal(got.at(-1).displayName,'Renamed between pages');assert.equal(new Set(got.map(x=>x.id)).size,105);
 assert.ok(!JSON.stringify(got).includes('PRIVATE_PROFILE'));
 const wrong=encode({...decode(page.nextParticipantCursor),id:s.outsider});await assert.rejects(market.conversationParticipants(s.owner,{...s.scope,cursor:wrong}),code('invalid_input'));
 await assert.rejects(market.conversation(s.owner,{...s.scope,cursor:page.nextParticipantCursor}),code('invalid_input'));
});

for(const [type,make] of [['agreement',signed],['order',ordered]]) test(`${type}: empty and 137-row microsecond history, new arrival, exact cursors and old-array compatibility`,async()=>{
 const s=await make(),other=await make(),id=Object.values(s.scope)[0];
 const empty=await market.conversation(s.worker,s.scope);assert.deepEqual(empty.items,[]);assert.equal(empty.nextCursor,null);assert.equal(empty.limit,30);assert.equal(empty.participantCount,2);
 assert.deepEqual(empty.participants.map(x=>x.role).sort(),type==='agreement'?['captain','publisher']:['buyer','seller']);
 await assert.rejects(market.conversation(s.outsider,s.scope),code('not_found'));
 const column=type==='agreement'?'agreement_id':'order_id';
 const records=Array.from({length:137},(_,i)=>({id:key(),body:`${type} record ${i}`,createdAt:`2026-01-01T00:00:00.${String(1+Math.floor(i/4)).padStart(6,'0')}Z`}));
 for(const r of records) await seedMessage(s.owner,`INSERT INTO campus.messages(id,sender_id,${column},body,created_at) VALUES($1,$2,$3,$4,$5)`,[r.id,s.worker,id,r.body,r.createdAt]);
 records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const before=await count('notifications'),first=await market.conversation(s.worker,{...s.scope,limit:'7'});
 assert.deepEqual(first.items.map(x=>x.id),records.slice(0,7).map(x=>x.id));
 const cursorShape=decode(first.nextCursor);assert.equal(cursorShape.createdAt,records[6].createdAt);
 for(const change of [{id:key()},{createdAt:'2026-01-01T00:00:00.999999Z'},{kind:'participants'},{scopeId:Object.values(other.scope)[0]},{unexpected:true}]) await assert.rejects(market.conversation(s.worker,{...s.scope,cursor:encode({...cursorShape,...change})}),code('invalid_input'));
 await assert.rejects(market.conversation(s.outsider,{...s.scope,cursor:first.nextCursor}),code('not_found'));
 await assert.rejects(market.conversationParticipants(s.worker,{...s.scope,cursor:first.nextCursor}),code('invalid_input'));
 assert.equal(await count('notifications'),before,'All conversation reads and failed reads are side-effect-free');
 const arrived=await market.sendMessage(s.owner,{...s.scope,body:'New arrival after first page'},key());
 const got=[...first.items];let cursor=first.nextCursor;
 while(cursor) {const page=await market.conversation(s.worker,{...s.scope,limit:'11',cursor});got.push(...page.items);cursor=page.nextCursor;}
 assert.deepEqual(got.map(({id,body,createdAt})=>({id,body,createdAt})),records);assert.equal(new Set(got.map(x=>x.id)).size,137);assert.ok(!got.some(x=>x.id===arrived.id));
 const refreshed=await market.conversation(s.worker,s.scope);assert.equal(refreshed.items[0].id,arrived.id);
 const legacy=await market.messages(s.worker,s.scope);assert.equal(legacy.length,100);assert.deepEqual(legacy.map(x=>x.id),[arrived.id,...records.map(x=>x.id)].slice(0,100));assert.equal(legacy[1].body,records[0].body);assert.ok(!('author' in legacy[1]));
 await f.owner.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1",[s.worker]);await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[s.worker]);assert.equal((await market.conversation(s.worker,{...s.scope,cursor:first.nextCursor})).items.length,30);
 await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[s.worker]);await assert.rejects(market.conversation(s.worker,{...s.scope,cursor:first.nextCursor}),code('account_locked'));
});

test('strict conversation query contracts reject duplicate scopes, noncanonical limits and impossible timestamps',()=>{
 const agreementId=key(),orderId=key();
 for(const q of [{},{agreementId,orderId},{agreementId,limit:'0'},{agreementId,limit:'51'},{agreementId,limit:'01'},{agreementId,limit:'1.0'},{agreementId,limit:1},{agreementId,limit:['1']},{agreementId,cursor:''},{agreementId,userId:key()},{agreementId:['x']}])assert.throws(()=>conversationQuery(q),code('invalid_input'));
 for(const query of [`agreementId=${agreementId}&agreementId=${agreementId}`,`orderId=${orderId}&limit=2&limit=2`])assert.throws(()=>conversationHttpQuery({url:`http://127.0.0.1/api/v1/conversations?${query}`}),code('invalid_input'));
 for(const createdAt of ['2026-02-29T00:00:00.000001Z','2026-01-01T00:00:00.001Z','2026-04-31T00:00:00.000001Z','0000-01-01T00:00:00.000001Z'])assert.throws(()=>conversationQuery({agreementId,cursor:encode({type:'agreement',scopeId:agreementId,kind:'messages',id:key(),createdAt})}),code('invalid_input'));
 assert.equal(conversationQuery({agreementId,limit:'100'},true).limit,100);assert.throws(()=>conversationQuery({agreementId,limit:'101'},true),code('invalid_input'));
});

for(const [type,make] of [['agreement',signed],['order',ordered]])test(`${type}: send receipt replay honors current account, membership and scope instead of cached private content`,async()=>{
 const s=await (type==='agreement'?signed(true):make()),actor=s.member??s.worker,requestKey=key(),body={...s.scope,body:'PRIVATE_REPLAY_SENTINEL'};
 const [first,second]=await Promise.all([market.sendMessage(actor,body,requestKey),market.sendMessage(actor,{...body,body:'  PRIVATE_REPLAY_SENTINEL  '},requestKey)]);assert.deepEqual(first,second);
 assert.equal(await count('messages','WHERE id=$1',[first.id]),1);assert.equal((await inbox(s.owner)).filter(x=>x.kind==='message.received').length,1);
 await assert.rejects(market.sendMessage(actor,{...body,body:'changed'},requestKey),code('idempotency_conflict'));
 await assert.rejects(market.sendMessage(actor,{...body,body:'x'.repeat(4001)},key()),code('invalid_input'));
 for(const [status,expected] of [['restricted','account_restricted'],['locked','account_locked']]) {await f.owner.query('UPDATE campus.users SET account_status=$2 WHERE id=$1',[actor,status]);await assert.rejects(market.sendMessage(actor,body,requestKey),e=>{assert.equal(e.code,expected);assert.ok(!JSON.stringify(e).includes(body.body));return true;});}
 await f.owner.query("UPDATE campus.users SET account_status='active' WHERE id=$1",[actor]);await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[actor]);await assert.rejects(market.sendMessage(actor,body,requestKey),code('membership_required'));
 await f.owner.query("UPDATE campus.affiliations SET valid_until=now()+interval '1 day',can_apply=false,student_valid_until=NULL WHERE user_id=$1",[actor]);assert.deepEqual(await market.sendMessage(actor,body,requestKey),first,'Valid non-student member can send');
 // Frozen order parties are immutable; agreement member removal is a privileged synthetic revocation.
 if(type==='order') {
  await assert.rejects(f.owner.query('UPDATE campus.orders SET buyer_id=$2 WHERE id=$1',[s.order.id,s.outsider]),code('23514'));
  await assert.rejects(market.sendMessage(s.outsider,body,requestKey),code('not_found'));
  assert.deepEqual(await market.sendMessage(actor,body,requestKey),first);
 } else {
  await f.owner.query('DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2',[s.agreement.id,actor]);
  await assert.rejects(market.sendMessage(actor,body,requestKey),code('not_found'));
 }
 assert.equal(await count('messages','WHERE id=$1',[first.id]),1);
});

test('order receipt replay waiting on its key rechecks natural membership expiration after the actual wait',async()=>{
 const s=await ordered(),requestKey=key(),body={...s.scope,body:'PRIVATE_WAIT_RECEIPT'};
 const original=await market.sendMessage(s.worker,body,requestKey);
 const blocker=new pg.Client({connectionString:f.urls.app});await blocker.connect();
 try {
  await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([s.worker,'message.send',requestKey])]);
  await f.owner.query("UPDATE campus.affiliations SET valid_until=clock_timestamp()+interval '1100 milliseconds' WHERE user_id=$1",[s.worker]);
  const pending=market.sendMessage(s.worker,body,requestKey).then(value=>({value}),error=>({error}));
  await waitBlockedBy(pid);await new Promise(r=>setTimeout(r,1250));await blocker.query('COMMIT');
  const result=await pending;assert.equal(result.error?.code,'membership_required');assert.equal(result.value,undefined);assert.ok(!JSON.stringify(result.error).includes(body.body));
  assert.equal(await count('messages','WHERE id=$1',[original.id]),1);assert.equal((await inbox(s.owner)).filter(x=>x.kind==='message.received').length,1);
 } finally {await blocker.query('ROLLBACK');await blocker.end();}
});

test('conversation SQL helpers have exact ACL/search_path and raw calls never broaden profiles or write authority',async()=>{
 const s=await signed();
 const names=['conversation_people','authorize_message_scope','notification_work_detail','immutable_notification_work_context','guard_message_send'];
 const rows=(await f.owner.query("SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege('campus_app',p.oid,'EXECUTE') AS app,has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth,has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='campus' AND p.proname=ANY($1)",[names])).rows;
 assert.equal(rows.length,5);
 for(const r of rows){assert.equal(r.app,['conversation_people','authorize_message_scope','notification_work_detail'].includes(r.proname),r.proname);assert.equal(r.auth,false);assert.equal(r.worker,false);assert.equal(r.public,false);assert.deepEqual(r.proconfig,['search_path=pg_catalog, campus, pg_temp']);assert.equal(r.prosecdef,['conversation_people','authorize_message_scope'].includes(r.proname));}
 for(const [kind,id] of [['agreement',s.agreement.id],['order',key()],['user',s.worker]])assert.equal((await store.as(s.outsider,c=>c.query('SELECT * FROM campus.conversation_people($1,$2)',[kind,id]))).rowCount,0);
 const exposed=(await store.as(s.owner,c=>c.query('SELECT * FROM campus.users WHERE id<>$1',[s.owner]))).rows;assert.equal(exposed.length,0);
 await assert.rejects(store.as(s.outsider,c=>c.query("SELECT campus.authorize_message_scope('agreement',$1)",[s.agreement.id])),e=>e.message==='not_found');
 await assert.rejects(store.as(s.outsider,c=>c.query("INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'raw outsider')",[s.outsider,s.agreement.id])),e=>e.code==='42501'||(e.code==='P0001'&&e.message==='not_found'));
 await f.owner.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1",[s.worker]);
 await assert.rejects(store.as(s.worker,c=>c.query("SELECT campus.authorize_message_scope('agreement',$1)",[s.agreement.id])),e=>e.message==='account_restricted');
 await assert.rejects(store.as(s.worker,c=>c.query("INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'raw restricted')",[s.worker,s.agreement.id])),code('42501'));
});

test('milestone notices bind exact stage, submission version and review; replay/no-op/rollback/redaction preserve anchors',async()=>{
 const s=await signed(true);await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1",[s.agreement.id]);
 const stages=(await market.agreement(s.worker,s.agreement.id)).milestones;
 const expected=[];
 const submit=async(stage,version,revision)=>{const k=key(),data={content:'PRIVATE_WORK_BODY',expectedVersion:version,expectedRevision:revision};const r=await market.submitMilestone(s.worker,stage.id,data,k);await market.submitMilestone(s.worker,stage.id,data,k);expected.push({kind:'milestone.submitted',stage:stage.id,submission:r.submission.id,version:version+1,revision:revision+1,review:null});return r;};
 const review=async(r,decision)=>{const k=key(),data={submissionId:r.submission.id,expectedVersion:r.milestone.version,expectedRevision:r.milestone.revision,...(decision==='revision_requested'?{feedback:'PRIVATE_FEEDBACK_BODY'}:{})};const fn=decision==='accepted'?'acceptMilestone':'requestMilestoneRevision';const result=await market[fn](s.owner,r.milestone.id,data,k);await market[fn](s.owner,r.milestone.id,data,k);expected.push({kind:`milestone.${decision}`,stage:r.milestone.id,submission:r.submission.id,version:r.milestone.version,revision:r.milestone.revision+1,review:result.receipt.reviewId});return result;};
 const first=await submit(stages[0],0,1);await review(first,'revision_requested');const second=await submit(stages[0],1,3);await review(second,'accepted');const other=await submit(stages[1],0,1);
 const beforeRollback=(await f.owner.query('SELECT to_jsonb(n) AS row FROM campus.notifications n ORDER BY id')).rows;
 const contextsBefore=(await f.owner.query('SELECT * FROM campus.notification_work_context ORDER BY notification_id')).rows;
 await assert.rejects(store.as(s.owner,async c=>{await c.query("SELECT campus.review_milestone_work($1,$2,1,2,'accepted','')",[stages[1].id,other.submission.id]);throw Error('Independent deliberate rollback');}),/Independent deliberate rollback/);
 assert.deepEqual((await f.owner.query('SELECT to_jsonb(n) AS row FROM campus.notifications n ORDER BY id')).rows,beforeRollback);assert.deepEqual((await f.owner.query('SELECT * FROM campus.notification_work_context ORDER BY notification_id')).rows,contextsBefore);
 assert.equal((await market.agreement(s.owner,s.agreement.id)).state,'active');
 await review(other,'accepted');
 const notes=(await inbox(s.member)).filter(n=>n.kind.startsWith('milestone.'));assert.equal(notes.length,6);
 for(const e of expected){const n=notes.find(n=>n.kind===e.kind&&n.workContext?.milestoneId===e.stage&&n.workContext?.milestoneRevision===e.revision);assert.ok(n,JSON.stringify(e));const stage=stages.find(x=>x.id===e.stage);assert.deepEqual(n.workContext,{type:'milestone',milestoneId:e.stage,milestoneTitle:stage.title,milestonePosition:stage.position,submissionId:e.submission,submissionVersion:e.version,milestoneRevision:e.revision,reviewId:e.review});assert.deepEqual(n.navigationAnchor,{type:'milestone',milestoneId:e.stage,submissionId:e.submission,reviewId:e.review});assert.ok(!JSON.stringify(n).match(/PRIVATE_WORK_BODY|PRIVATE_FEEDBACK_BODY/));}
 const completion=(await inbox(s.member)).find(n=>n.kind==='agreement.completed');assert.equal(completion.workContext,null);assert.equal(completion.navigationAnchor,null);
 const raw=(await f.owner.query('SELECT * FROM campus.notification_work_context')).rows;assert.ok(!JSON.stringify(raw).match(/PRIVATE_|First signed|Second signed|displayName|content|feedback/));
 const target=notes[0],ackKey=key(),ack=await market.readNotification(s.member,target.id,{},ackKey);
 await f.owner.query('UPDATE campus.milestones SET state=state WHERE id=$1',[stages[0].id]);assert.equal((await inbox(s.member)).filter(n=>n.kind.startsWith('milestone.')).length,6);
 await assert.rejects(store.as(s.member,c=>c.query('DELETE FROM campus.notification_work_context WHERE notification_id=$1',[target.id])),code('42501'));
 await assert.rejects(store.as(s.member,c=>c.query('UPDATE campus.notification_work_context SET submission_version=99 WHERE notification_id=$1',[target.id])),code('42501'));
 await assert.rejects(store.as(s.member,c=>c.query('INSERT INTO campus.notification_work_context SELECT * FROM campus.notification_work_context WHERE notification_id=$1',[target.id])),code('42501'));
 await assert.rejects(f.owner.query('UPDATE campus.notification_work_context SET submission_version=submission_version WHERE notification_id=$1',[target.id]),code('23514'));
 await assert.rejects(store.as(s.member,c=>c.query("SELECT campus.emit_notification('forged','milestone.accepted','agreement',$1,ARRAY[$2::uuid],NULL)",[s.agreement.id,s.member])),code('42501'));
 // Invoke unchanged legacy emitter as fixture owner: it must not manufacture exact work context.
 await f.owner.query("SELECT campus.emit_notification('legacy-fixture-'||$1::text,'milestone.submitted','agreement',$1::uuid,ARRAY[$2::uuid],NULL)",[s.agreement.id,s.member]);
 const legacy=(await inbox(s.member)).find(n=>n.kind==='milestone.submitted'&&!n.workContext);assert.ok(legacy);assert.equal(legacy.navigationAnchor,null);
 await f.owner.query('DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2',[s.agreement.id,s.member]);
 const redacted=await market.readNotification(s.member,target.id,{},ackKey);assert.equal(redacted.readAt,ack.readAt);for(const field of ['target','contextLabel','workContext','navigationAnchor'])assert.equal(redacted[field],null);assert.ok(!JSON.stringify(redacted).includes(stages[0].id));
 assert.equal((await store.as(s.member,c=>c.query('SELECT campus.notification_work_detail($1) AS detail',[target.id]))).rows[0].detail,null);
 assert.equal((await store.as(s.outsider,c=>c.query('SELECT * FROM campus.notification_work_context'))).rowCount,0);
});

for(const [type,make] of [['agreement',signed],['order',ordered]])for(const state of ['restricted','expired'])test(`${type}: raw app SQL denies ${state} writes while conversation history remains readable`,async()=>{
 const s=await make(),id=Object.values(s.scope)[0],column=type==='agreement'?'agreement_id':'order_id';
 await market.sendMessage(s.worker,{...s.scope,body:'History retained'},key());
 if(state==='restricted')await f.owner.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1",[s.worker]);
 else await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[s.worker]);
 assert.equal((await market.conversation(s.worker,s.scope)).items[0].body,'History retained');
 const messagesBefore=await count('messages'),notificationsBefore=await count('notifications');
 await assert.rejects(store.as(s.worker,c=>c.query(`INSERT INTO campus.messages(sender_id,${column},body) VALUES($1,$2,'Should never commit')`,[s.worker,id])),code('42501'));
 assert.equal(await count('messages'),messagesBefore);assert.equal(await count('notifications'),notificationsBefore);
});
