// Independent bounded regression: actual SQL wait barrier, no preview or product edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID as key} from 'node:crypto';
import {fixture} from '../../backend/fixture.mjs';
import {localConfig,connectionString} from '../../../scripts/backend-local.mjs';
import {createStore} from '../../../backend/db/store.mjs';
import {createMarket} from '../../../backend/modules/market.mjs';

assert.equal(new URL(connectionString(localConfig(),'migrator')).hostname,'127.0.0.1');
const f=await fixture(),database=new URL(f.urls.app).pathname.slice(1);
assert.match(database,/^campus_test_[a-f0-9]{32}$/);
for(const value of Object.values(f.urls)){const u=new URL(value);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/'+database);}
const store=createStore(f.urls),market=createMarket(store);
const observer=new pg.Client({connectionString:connectionString(f.config,'migrator',database)});
await observer.connect();
const migrations=(await observer.query('SELECT name,checksum FROM campus.schema_migrations ORDER BY name')).rows;
console.log(JSON.stringify({evidence:'revocation-race-input',database,migrations}));
test.after(async()=>{await store.close();await observer.end();await f.close();});
const rev=t=>({expectedRevision:t.revision});
async function signed() {
 const owner=await f.user('Race publisher'),captain=await f.user('Race captain'),member=await f.user('Race ordinary signer');
 let team=await market.createTeam(captain,{name:'Independent race team',context:{purpose:'Synthetic permission race',activities:'Local database checks',timeCommitment:'One test',projectContext:'No private live data'}},key());
 team=await market.inviteMember(captain,team.id,{...rev(team),userId:member},key());
 await market.acceptMembership(member,team.id,rev(team),key());
 const task=await market.publishTask(owner,{title:'Independent race scope',category:'Research',description:'Synthetic',rewardCents:100,milestones:[{title:'Stage',deliverable:'Synthetic',amountCents:100}]},key());
 const app=await market.apply(captain,task.id,{proposal:'Synthetic',teamId:team.id},key());
 await market.consentApplication(member,app.id,{},key());await market.inviteApplicant(owner,app.id,{},key());
 const agreement=await market.acceptInvitation(captain,app.id,{},key());
 assert.equal((await market.conversation(member,{agreementId:agreement.id})).participantCount,3);
 return {owner,captain,member,agreement};
}
async function waitForBlocker(blockerPid,expectedPid=null) {
 const deadline=Date.now()+2000;
 while(Date.now()<deadline) {
  const result=await observer.query("SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=$1 AND $2=ANY(pg_blocking_pids(pid)) AND ($3::int IS NULL OR pid=$3)",[database,blockerPid,expectedPid]);
  if(result.rowCount) {
   assert.equal(result.rowCount,1,'Exactly the requested fixture sender must be blocked');
   const row=result.rows[0];assert.equal(row.wait_event_type,'Lock');assert.ok(row.blockers.includes(blockerPid));
   const locks=(await observer.query('SELECT locktype,mode,granted,relation::regclass::text AS relation FROM pg_locks WHERE pid=$1 AND NOT granted',[row.pid])).rows;
   assert.ok(locks.length>0,'Observed pg_locks must contain an actual ungranted lock');
   return {blockedPid:row.pid,blockerPid,waitEventType:row.wait_event_type,waitEvent:row.wait_event,blockers:row.blockers,ungrantedLocks:locks};
  }
  // Poll delay alone is never success: the loop must observe both blocking PID and ungranted lock.
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('No actual fixture lock barrier was observed within 2 seconds');
}
async function blockAndRevoke(s,launch,expectedPid=null) {
 await f.owner.query('BEGIN');
 let pending;
 try {
  await f.owner.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
  const blockerPid=(await f.owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await f.owner.query('SELECT id FROM campus.agreements WHERE id=$1 FOR UPDATE',[s.agreement.id]);
  pending=launch();
  const barrier=await waitForBlocker(blockerPid,expectedPid);
  const revoked=await f.owner.query('DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2 RETURNING user_id',[s.agreement.id,s.member]);
  assert.equal(revoked.rowCount,1);await f.owner.query('COMMIT');
  return {barrier,result:await pending};
 } finally {await f.owner.query('ROLLBACK');if(pending)await pending;}
}
const safeError=e=>({code:e.code??null,message:e.message});
async function readback(s,messageId) {
 const memberRows=(await observer.query('SELECT user_id FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2',[s.agreement.id,s.member])).rowCount;
 const messages=(await observer.query('SELECT id,sender_id,agreement_id,body FROM campus.messages WHERE id=$1',[messageId])).rows;
 const notifications=(await observer.query('SELECT id,recipient_id,event_key,kind,target_type,target_id FROM campus.notifications WHERE event_key=$1 ORDER BY recipient_id',['message:'+messageId])).rows;
 let currentScope;
 try {await market.conversation(s.member,{agreementId:s.agreement.id});currentScope='allowed';}catch(e){currentScope=e.code;}
 return {memberRows,currentScope,messages,notifications};
}

test('raw app INSERT must recheck ordinary signer revocation after waiting on agreement lock',async()=>{
 const s=await signed(),messageId=key(),client=new pg.Client({connectionString:f.urls.app});await client.connect();
 try {
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");await client.query("SELECT set_config('campus.actor_id',$1,true)",[s.member]);
  const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const run=await blockAndRevoke(s,()=>client.query("INSERT INTO campus.messages(id,sender_id,agreement_id,body) VALUES($1,$2,$3,'Synthetic raced message') RETURNING id",[messageId,s.member,s.agreement.id]).then(r=>({returnedIds:r.rows.map(x=>x.id)}),e=>({error:safeError(e)})),pid);
  if(run.result.error)await client.query('ROLLBACK');else await client.query('COMMIT');
  const state=await readback(s,messageId);
  // Fresh non-racing request is a control: scope was truly revoked, not merely hidden by fixture timing.
  let fresh;
  try {await store.as(s.member,c=>c.query("INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'Synthetic fresh denial control')",[s.member,s.agreement.id]));fresh={committed:true};}catch(e){fresh={error:safeError(e)};}
  console.log(JSON.stringify({evidence:'raw-revocation-race',...run,state,fresh}));
  assert.equal(state.memberRows,0);assert.equal(state.currentScope,'not_found');assert.equal(fresh.error?.message,'not_found');
  assert.deepEqual({committedMessageCount:state.messages.length,notificationCount:state.notifications.length},{committedMessageCount:0,notificationCount:0},'Revoked signer must not commit a raw SQL message or notifications after the observed wait');
  assert.ok(run.result.error,'The raced insert itself must be denied');
 } finally {await client.query('ROLLBACK');await client.end();}
});

test('service send denies the same ordinary signer revocation after the observed agreement lock wait',async()=>{
 const s=await signed(),requestKey=key();
 const run=await blockAndRevoke(s,()=>market.sendMessage(s.member,{agreementId:s.agreement.id,body:'Synthetic service race'},requestKey).then(value=>({value}),e=>({error:safeError(e)})));
 const rows=(await observer.query('SELECT id FROM campus.messages WHERE agreement_id=$1 AND sender_id=$2',[s.agreement.id,s.member])).rows;
 const notes=(await observer.query("SELECT id FROM campus.notifications WHERE target_id=$1 AND kind='message.received'",[s.agreement.id])).rows;
 const receipts=(await observer.query("SELECT key FROM campus.idempotency WHERE actor_id=$1 AND operation='message.send' AND key=$2",[s.member,requestKey])).rows;
 console.log(JSON.stringify({evidence:'service-revocation-race-control',...run,committedMessageCount:rows.length,notificationCount:notes.length,receiptCount:receipts.length}));
 assert.equal(run.result.error?.code,'not_found');assert.equal(rows.length,0);assert.equal(notes.length,0);assert.equal(receipts.length,0);
});
