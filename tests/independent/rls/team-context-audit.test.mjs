// Local independent-agent assertions. Each fixture uses a disposable campus_test_* DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as key } from 'node:crypto';
import { fixture } from '../../backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
import { completeContext } from '../team-context-fixture.mjs';
const f = await fixture(), store = createStore(f.urls), market = createMarket(store);
test.after(async()=>{await store.close();await f.close();});
const reject = (promise,code) => assert.rejects(promise,{code});
const sqlReject = promise => assert.rejects(promise,e=>e.code==='22023'&&e.message==='invalid_input');
const revision = async (actor,id) => ({expectedRevision:(await market.team(actor,id)).revision});
async function people() {
  return {captain:await f.user('Context captain'),member:await f.user('Context member'),
    peer:await f.user('Context peer'),outsider:await f.user('Context outsider'),publisher:await f.user('Context publisher')};
}
const create = (actor,label='Initial') => market.createTeam(actor,{name:'Context audit',context:completeContext(label)},key());
const invite = async (u,id,target=u.member) => market.inviteMember(u.captain,id,{userId:target,...await revision(u.captain,id)},key());
const accept = async (actor,id) => market.acceptMembership(actor,id,await revision(actor,id),key());
const edit = async (actor,id,label) => market.updateTeamContext(actor,id,{...await revision(actor,id),context:completeContext(label)},key());
const rawContext = (actor,id) => store.as(actor,async c=>(await c.query('SELECT * FROM campus.team_contexts WHERE team_id=$1',[id])).rows);

for (const terminal of ['declined','revoked','left','removed']) {
  test(`context is visible while invited/accepted, then hidden after ${terminal} in DTO and raw SQL`,async()=>{
    const u=await people(),t=await create(u.captain);
    await invite(u,t.id);
    assert.deepEqual((await market.team(u.member,t.id)).context,completeContext('Initial'));
    assert.equal((await rawContext(u.member,t.id)).length,1);
    if(['left','removed'].includes(terminal)) {
      await accept(u.member,t.id);
      assert.deepEqual((await market.team(u.member,t.id)).context,completeContext('Initial'));
    }
    const r=await revision(u.captain,t.id);
    if(terminal==='declined') await market.declineMembership(u.member,t.id,r,key());
    if(terminal==='revoked') await market.revokeInvitation(u.captain,t.id,u.member,r,key());
    if(terminal==='left') await market.leaveTeam(u.member,t.id,r,key());
    if(terminal==='removed') await market.removeMember(u.captain,t.id,u.member,r,key());
    await edit(u.captain,t.id,'Private later activity');
    const view=await market.team(u.member,t.id);
    assert.equal(view.context,null);assert.equal(view.own_state,terminal);
    assert.equal(view.owner_id,null);assert.deepEqual(view.members.map(x=>x.user_id),[u.member]);
    assert.deepEqual(await rawContext(u.member,t.id),[]);
    const summary=(await market.teams(u.member)).find(x=>x.id===t.id);
    assert.ok(summary);assert.equal(summary.context,undefined);
    await store.as(u.member,async c=>{
      assert.equal((await c.query('SELECT * FROM campus.teams WHERE id=$1',[t.id])).rowCount,0);
      const projected=(await c.query('SELECT * FROM campus.teams_visible() WHERE id=$1',[t.id])).rows[0];
      assert.equal(projected.context,undefined);
      assert.ok(!JSON.stringify(projected).includes('Private later activity'));
    });
    await reject(market.team(u.outsider,t.id),'not_found');
    for(const actor of [u.outsider,null]) assert.deepEqual(await rawContext(actor,t.id),[]);
    await invite(u,t.id);
    assert.deepEqual((await market.team(u.member,t.id)).context,completeContext('Private later activity'));
    await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[u.member]);
    await reject(market.team(u.member,t.id),'account_locked');
    assert.deepEqual(await rawContext(u.member,t.id),[]);
  });
}

test('context inputs have matching API/SQL validation, including boundaries and no partial writes',async()=>{
  const u=await people(),t=await create(u.captain);
  const before=await market.team(u.captain,t.id);
  const bad=[null,[],42,{},
    {...completeContext(),purpose:' \t\n '},
    {...completeContext(),activities:''},
    {...completeContext(),timeCommitment:3},
    {...completeContext(),projectContext:null},
    {...completeContext(),extra:'undeclared'},
    {...completeContext(),purpose:'x'.repeat(1001)},
    {...completeContext(),activities:'x'.repeat(1501)},
    {...completeContext(),timeCommitment:'x'.repeat(501)},
    {...completeContext(),projectContext:'x'.repeat(1501)}];
  for(const value of bad) {
    await reject(market.updateTeamContext(u.captain,t.id,{expectedRevision:t.revision,context:value},key()),'invalid_input');
    await sqlReject(store.as(u.captain,c=>c.query('SELECT campus.set_team_context($1,$2,$3)',[t.id,t.revision,JSON.stringify(value)])));
  }
  assert.deepEqual(await market.team(u.captain,t.id),before);
  const exact={purpose:'x'.repeat(1000),activities:'y'.repeat(1500),timeCommitment:'z'.repeat(500),projectContext:'p'.repeat(1500)};
  const changed=await market.updateTeamContext(u.captain,t.id,{expectedRevision:t.revision,context:exact},key());
  assert.deepEqual(changed.context,exact);assert.equal(changed.revision,t.revision+1);
  const normalized=await market.updateTeamContext(u.captain,t.id,{expectedRevision:changed.revision,context:{purpose:'  P  ',activities:'\nA\t',timeCommitment:' T ',projectContext:'   '}},key());
  assert.deepEqual(normalized.context,{purpose:'P',activities:'A',timeCommitment:'T',projectContext:''});
});

test('legacy blank pending invitation can accept, but service/raw SQL new invites and reinvites need context',async()=>{
  const u=await people();
  const t=await market.createTeam(u.captain,{name:'Compatible empty draft'},key());
  assert.deepEqual(t.context,{purpose:'',activities:'',timeCommitment:'',projectContext:''});
  await reject(invite(u,t.id),'team_context_required');
  const rawId=await store.as(u.captain,async c=>(await c.query("SELECT campus.create_team('Raw empty draft') AS id")).rows[0].id);
  await assert.rejects(store.as(u.captain,c=>c.query("SELECT campus.change_team($1,'invite',$2,1)",[rawId,u.peer])),e=>e.message==='team_context_required');
  assert.equal((await market.team(u.captain,rawId)).revision,1);
  // Construct a pre-009 pending row only in this disposable owner fixture.
  // This checks compatibility semantics, not an in-place production migration.
  await f.owner.query('BEGIN');
  try {
    await f.owner.query('ALTER TABLE campus.team_members DISABLE TRIGGER invitation_context_required');
    await f.owner.query("INSERT INTO campus.team_members(team_id,user_id,state) VALUES($1,$2,'invited')",[t.id,u.member]);
    await f.owner.query('ALTER TABLE campus.team_members ENABLE TRIGGER invitation_context_required');
    await f.owner.query('COMMIT');
  } catch(e) {await f.owner.query('ROLLBACK');throw e;}
  assert.equal((await accept(u.member,t.id)).own_state,'accepted');
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  const before=await market.team(u.captain,t.id);
  await reject(invite(u,t.id),'team_context_required');
  assert.equal((await market.team(u.captain,t.id)).revision,before.revision);
  await assert.rejects(store.as(u.captain,c=>c.query("SELECT campus.change_team($1,'invite',$2,$3)",[t.id,u.member,before.revision])),e=>e.message==='team_context_required');
  await edit(u.captain,t.id,'Filled after legacy acceptance');
  assert.equal((await invite(u,t.id)).members.find(x=>x.user_id===u.member).state,'invited');
});

test('only current captain edits active teams; raw SQL, transfer, locked and archived boundaries hold',async()=>{
  const u=await people(),t=await create(u.captain);
  await invite(u,t.id);const r=await revision(u.captain,t.id),body={...r,context:completeContext('Forbidden')};
  await reject(market.updateTeamContext(u.member,t.id,body,key()),'not_owner');
  await assert.rejects(store.as(u.member,c=>c.query('SELECT campus.set_team_context($1,$2,$3)',[t.id,r.expectedRevision,JSON.stringify(body.context)])),e=>e.code==='42501'&&e.message==='not_owner');
  await reject(market.updateTeamContext(u.outsider,t.id,body,key()),'not_found');
  await accept(u.member,t.id);
  await reject(edit(u.member,t.id,'Not captain'),'not_owner');
  await market.transferCaptain(u.captain,t.id,{userId:u.member,...await revision(u.captain,t.id)},key());
  await reject(edit(u.captain,t.id,'Former captain'),'not_owner');
  await edit(u.member,t.id,'New captain');
  await market.leaveTeam(u.captain,t.id,await revision(u.captain,t.id),key());
  const current=await market.team(u.member,t.id);
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[u.member]);
  await reject(market.updateTeamContext(u.member,t.id,{expectedRevision:current.revision,context:completeContext('Locked')},key()),'account_locked');
  await assert.rejects(store.as(u.member,c=>c.query('SELECT campus.set_team_context($1,$2,$3)',[t.id,current.revision,JSON.stringify(completeContext())])),e=>e.message==='account_locked');
  await f.owner.query("UPDATE campus.users SET account_status='active' WHERE id=$1",[u.member]);
  const archived=await market.archiveTeam(u.member,t.id,await revision(u.member,t.id),key());
  await reject(market.updateTeamContext(u.member,t.id,{expectedRevision:archived.revision,context:completeContext('Archived')},key()),'team_archived');
  assert.deepEqual((await market.team(u.member,t.id)).context,completeContext('New captain'));
});

test('context retries return fresh permitted state without rewriting later context or leaking after exit',async()=>{
  const u=await people(),createKey=key(),createBody={name:'Replay team',context:completeContext('First')};
  const t=await market.createTeam(u.captain,createBody,createKey);
  const requestKey=key(),body={expectedRevision:t.revision,context:completeContext('Edited')};
  const first=await market.updateTeamContext(u.captain,t.id,body,requestKey);
  const later=await edit(u.captain,t.id,'Later');
  const replay=await market.updateTeamContext(u.captain,t.id,body,requestKey);
  assert.equal(replay.revision,later.revision);assert.deepEqual(replay.context,completeContext('Later'));
  await reject(market.updateTeamContext(u.captain,t.id,{...body,context:completeContext('Different')},requestKey),'idempotency_conflict');
  await reject(market.updateTeamContext(u.captain,t.id,body,key()),'team_revision_changed');
  assert.equal(first.revision,t.revision+1);
  const noOp=await market.updateTeamContext(u.captain,t.id,{expectedRevision:later.revision,context:completeContext('Later')},key());
  assert.equal(noOp.revision,later.revision);
  await invite(u,t.id);await accept(u.member,t.id);
  await market.transferCaptain(u.captain,t.id,{userId:u.member,...await revision(u.captain,t.id)},key());
  await market.leaveTeam(u.captain,t.id,await revision(u.captain,t.id),key());
  await edit(u.member,t.id,'After former captain left');
  for(const view of [await market.updateTeamContext(u.captain,t.id,body,requestKey),await market.createTeam(u.captain,createBody,createKey)]) {
    assert.equal(view.context,null);assert.equal(view.own_state,'left');assert.equal(view.owner_id,null);
  }
  const receipts=(await f.owner.query("SELECT response FROM campus.idempotency WHERE actor_id=$1 AND operation LIKE 'team.%'",[u.captain])).rows;
  for(const row of receipts) assert.deepEqual(row.response,{id:t.id});
});

async function waitForTeamWaiters(id,count) {
  for(let n=0;n<100;n++) {
    const {rows}=await f.owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND NOT granted
      AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
      AND objid=(hashtextextended($1,0)&4294967295)::oid`,['team:'+id]);
    if(rows[0].n>=count) return;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('Expected context/accept lock queue');
}
test('both forced edit-versus-accept queue orders reject the stale action without silent consent',async()=>{
  for(const editFirst of [true,false]) {
    const u=await people(),t=await create(u.captain);await invite(u,t.id);
    const r=await revision(u.captain,t.id);
    const change=()=>market.updateTeamContext(u.captain,t.id,{...r,context:completeContext('Revised before response')},key());
    const join=()=>market.acceptMembership(u.member,t.id,r,key());
    // Attach rejection handlers immediately: the losing request is expected.
    const settle=p=>p.then(value=>({ok:true,value}),error=>({ok:false,error}));
    let first,second;
    await f.owner.query('BEGIN');
    await f.owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['team:'+t.id]);
    try {
      first=settle((editFirst?change:join)());await waitForTeamWaiters(t.id,1);
      second=settle((editFirst?join:change)());await waitForTeamWaiters(t.id,2);
    } finally {await f.owner.query('COMMIT');}
    const outcomes=await Promise.all([first,second]);
    assert.equal(outcomes[0].ok,true);assert.equal(outcomes[1].ok,false);
    assert.equal(outcomes[1].error.code,'team_revision_changed');
    const current=await market.team(u.member,t.id);
    assert.equal(current.revision,r.expectedRevision+1);
    assert.equal(current.own_state,editFirst?'invited':'accepted');
    assert.deepEqual(current.context,completeContext(editFirst?'Revised before response':'Initial'));
  }
});

test('context edits cannot rewrite existing application consent or signed agreement terms',async()=>{
  const u=await people(),t=await create(u.captain);await invite(u,t.id);await accept(u.member,t.id);
  const task=await market.publishTask(u.publisher,{title:'Frozen research scope',category:'Research',description:'Synthetic',rewardCents:100,milestones:[{title:'Summary',amountCents:100,deliverable:'A cited summary'}]},key());
  const app=await market.apply(u.captain,task.id,{proposal:'Original consented scope',teamId:t.id},key());
  await market.consentApplication(u.member,app.id,{},key());
  await market.inviteApplicant(u.publisher,app.id,{},key());
  const agreement=await market.acceptInvitation(u.captain,app.id,{},key());
  const snapshot=async()=>({
    app:(await f.owner.query('SELECT * FROM campus.applications WHERE id=$1',[app.id])).rows,
    consent:(await f.owner.query('SELECT * FROM campus.application_members WHERE application_id=$1 ORDER BY user_id',[app.id])).rows,
    agreement:(await f.owner.query('SELECT * FROM campus.agreements WHERE id=$1',[agreement.id])).rows,
    members:(await f.owner.query('SELECT * FROM campus.agreement_members WHERE agreement_id=$1 ORDER BY user_id',[agreement.id])).rows,
    milestones:(await f.owner.query('SELECT * FROM campus.milestones WHERE agreement_id=$1 ORDER BY position',[agreement.id])).rows,
  });
  const before=await snapshot();
  await market.updateTeamContext(u.captain,t.id,{...await revision(u.captain,t.id),context:{...completeContext('New activities'),projectContext:'This text does not amend the original agreement.'}},key());
  assert.deepEqual(await snapshot(),before);
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  assert.equal((await market.team(u.member,t.id)).context,null);
  assert.equal((await market.agreement(u.member,agreement.id)).id,agreement.id);
  assert.deepEqual(await snapshot(),before);
});

test('current context DML and private history are denied across runtime roles; owner history is immutable',async()=>{
  const u=await people(),t=await create(u.captain);await edit(u.captain,t.id,'History entry');
  const functions=(await f.owner.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('campus_app',p.oid,'EXECUTE') AS app,
    has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth,
    has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='campus' AND p.proname IN ('create_team_with_context','set_team_context','normalize_team_context','require_invitation_context','immutable_team_context_event')`)).rows;
  assert.equal(functions.length,5);
  for(const fn of functions) {
    assert.equal(fn.prosecdef,['create_team_with_context','set_team_context'].includes(fn.proname));
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, campus, pg_temp'));
    assert.equal(fn.app,fn.prosecdef);assert.equal(fn.auth,false);assert.equal(fn.worker,false);assert.equal(fn.public_execute,false);
  }
  for(const pool of [store.app,store.auth,store.worker]) await reject(pool.query('SELECT * FROM campus.team_context_events'),'42501');
  for(const pool of [store.auth,store.worker]) await reject(pool.query('SELECT * FROM campus.team_contexts'),'42501');
  for(const sql of ["UPDATE campus.team_contexts SET purpose='forged' WHERE team_id=$1",'DELETE FROM campus.team_contexts WHERE team_id=$1',"INSERT INTO campus.team_contexts(team_id,purpose) VALUES($1,'forged')"])
    await reject(store.as(u.captain,c=>c.query(sql,[t.id])),'42501');
  await reject(store.as(u.captain,c=>c.query('TRUNCATE campus.team_contexts')),'42501');
  await reject(f.owner.query("UPDATE campus.team_context_events SET purpose='rewritten' WHERE team_id=$1",[t.id]),'23514');
  await reject(f.owner.query('DELETE FROM campus.team_context_events WHERE team_id=$1',[t.id]),'23514');
  const history=(await f.owner.query('SELECT action,revision FROM campus.team_context_events WHERE team_id=$1 ORDER BY revision',[t.id])).rows;
  assert.deepEqual(history,[{action:'create',revision:1},{action:'update',revision:2}]);
  await invite(u,t.id);
  await reject(store.as(u.member,c=>c.query('SELECT * FROM campus.team_context_events WHERE team_id=$1',[t.id])),'42501');
});
