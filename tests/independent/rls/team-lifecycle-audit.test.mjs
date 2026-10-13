// Independent adversarial lifecycle checks; all data is synthetic and disposable.
import test from 'node:test';
import { completeContext } from '../team-context-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
const f = await fixture();
const store = createStore(f.urls), market = createMarket(store);
const key = () => randomUUID();
const revision = async (actor,id) => ({expectedRevision:(await market.team(actor,id)).revision});
const reject = (promise,code) => assert.rejects(promise,{code});
async function people() {
  return {captain:await f.user('Audit captain'),member:await f.user('Audit member'),
    late:await f.user('Audit later member'),outsider:await f.user('Audit outsider'),publisher:await f.user('Audit publisher')};
}
const invite = async (captain,id,userId) => market.inviteMember(captain,id,{userId,...await revision(captain,id)},key());
const accept = async (actor,id) => market.acceptMembership(actor,id,await revision(actor,id),key());
async function teamOf(u,includeMember=true) {
  const team=await market.createTeam(u.captain,{name:'Independent lifecycle audit',context:completeContext()},key());
  if(includeMember) { await invite(u.captain,team.id,u.member); await accept(u.member,team.id); }
  return team;
}
const publish = actor => market.publishTask(actor,{title:'Frozen participant audit',category:'Research',description:'Synthetic fixture',rewardCents:100,milestones:[{title:'Report',amountCents:100,deliverable:'Report'}]},key());
const membership = async (id,user) => (await f.owner.query('SELECT state FROM campus.team_members WHERE team_id=$1 AND user_id=$2',[id,user])).rows[0]?.state;
const expire = actor => f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[actor]);
test.after(async()=>{await store.close();await f.close();});

test('terminal members receive only their own historical state and cannot see later captains or rosters',async()=>{
  const u=await people(),t=await teamOf(u);
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  await invite(u.captain,t.id,u.late); await accept(u.late,t.id);
  await market.transferCaptain(u.captain,t.id,{userId:u.late,...await revision(u.captain,t.id)},key());
  const view=await market.team(u.member,t.id);
  assert.equal(view.owner_id,null); assert.equal(view.can_view_roster,false); assert.equal(view.own_state,'left');
  assert.deepEqual(view.members.map(m=>m.user_id),[u.member]);
  const summary=(await market.teams(u.member)).find(x=>x.id===t.id);
  assert.equal(summary.owner_id,null);
  await store.as(u.member,async c=>{
    assert.equal((await c.query('SELECT * FROM campus.teams WHERE id=$1',[t.id])).rowCount,0);
    assert.deepEqual((await c.query('SELECT user_id FROM campus.team_members WHERE team_id=$1',[t.id])).rows.map(x=>x.user_id),[u.member]);
    assert.deepEqual((await c.query('SELECT user_id FROM campus.team_people($1)',[t.id])).rows.map(x=>x.user_id),[u.member]);
    assert.ok((await c.query('SELECT user_id FROM campus.team_membership_events WHERE team_id=$1',[t.id])).rows.every(x=>x.user_id===u.member));
  });
  await reject(market.team(u.outsider,t.id),'not_found');
  await reject(market.teamCandidate(u.member,t.id,{userId:u.late}),'not_found');
});

test('old accept and decline replays return fresh state without consuming a later invitation cycle',async()=>{
  const u=await people(),t=await teamOf(u,false);
  await invite(u.captain,t.id,u.member);
  const declineBody=await revision(u.member,t.id),declineKey=key();
  await market.declineMembership(u.member,t.id,declineBody,declineKey);
  await invite(u.captain,t.id,u.member);
  const current=await market.team(u.member,t.id);
  const replay=await market.declineMembership(u.member,t.id,declineBody,declineKey);
  assert.equal(replay.own_state,'invited');assert.equal(replay.revision,current.revision);
  await reject(market.declineMembership(u.member,t.id,declineBody,key()),'team_revision_changed');
  const acceptBody=await revision(u.member,t.id),acceptKey=key();
  await market.acceptMembership(u.member,t.id,acceptBody,acceptKey);
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  await invite(u.captain,t.id,u.member);
  const acceptReplay=await market.acceptMembership(u.member,t.id,acceptBody,acceptKey);
  assert.equal(acceptReplay.own_state,'invited');
  assert.equal(await membership(t.id,u.member),'invited');
  await reject(market.acceptMembership(u.member,t.id,acceptBody,key()),'team_revision_changed');
  const history=(await f.owner.query('SELECT action,invitation_version FROM campus.team_membership_events WHERE team_id=$1 AND user_id=$2 ORDER BY revision',[t.id,u.member])).rows;
  assert.deepEqual(history.map(x=>x.action),['invite','decline','invite','accept','leave','invite']);
  assert.deepEqual(history.map(x=>x.invitation_version),[1,1,2,2,2,3]);
  const receipts=(await f.owner.query("SELECT response FROM campus.idempotency WHERE actor_id=$1 AND operation LIKE 'team.%'",[u.member])).rows;
  assert.ok(receipts.length>=3);for(const row of receipts) assert.deepEqual(row.response,{id:t.id});
});

test('captain authority, self-removal, eligible succession and direct SQL write boundaries are enforced',async()=>{
  const u=await people(),t=await teamOf(u);
  const body=await revision(u.captain,t.id);
  await reject(market.removeMember(u.member,t.id,u.captain,body,key()),'not_owner');
  await reject(market.transferCaptain(u.member,t.id,{userId:u.member,...body},key()),'not_owner');
  await reject(market.removeMember(u.outsider,t.id,u.member,body,key()),'not_found');
  await reject(market.removeMember(u.captain,t.id,u.captain,body,key()),'captain_transfer_required');
  await reject(market.leaveTeam(u.captain,t.id,body,key()),'captain_transfer_required');
  await f.owner.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1",[u.member]);
  await reject(market.transferCaptain(u.captain,t.id,{userId:u.member,...body},key()),'student_verification_required');
  await f.owner.query("UPDATE campus.users SET account_status='active' WHERE id=$1",[u.member]);
  await expire(u.captain);
  const transferred=await market.transferCaptain(u.captain,t.id,{userId:u.member,...body},key());
  assert.equal(transferred.owner_id,u.member);
  await reject(market.inviteMember(u.captain,t.id,{userId:u.late,...await revision(u.captain,t.id)},key()),'not_owner');
  for(const sql of [
    "UPDATE campus.teams SET owner_id=$2 WHERE id=$1",
    "UPDATE campus.team_members SET state='accepted' WHERE team_id=$1 AND user_id=$2",
    "DELETE FROM campus.team_membership_events WHERE team_id=$1 AND user_id=$2",
  ]) await assert.rejects(store.as(u.captain,c=>c.query(sql,[t.id,u.captain])),{code:'42501'});
  await assert.rejects(store.auth.query('SELECT campus.change_team($1,$2,$3,$4)',[t.id,'archive',u.captain,1]),{code:'42501'});
  await assert.rejects(store.worker.query('SELECT campus.create_team($1)',['Forbidden']),{code:'42501'});
});

test('expired and restricted accounts can exit and unwind while locked accounts and new activity remain blocked',async()=>{
  const u=await people(),t=await teamOf(u);
  await invite(u.captain,t.id,u.late);
  await expire(u.late);
  await reject(market.acceptMembership(u.late,t.id,await revision(u.late,t.id),key()),'student_verification_required');
  await market.declineMembership(u.late,t.id,await revision(u.late,t.id),key());
  await expire(u.member);
  assert.equal((await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key())).own_state,'left');
  await invite(u.captain,t.id,u.outsider);
  await f.owner.query("UPDATE campus.users SET account_status='restricted' WHERE id=$1",[u.captain]);
  await market.revokeInvitation(u.captain,t.id,u.outsider,await revision(u.captain,t.id),key());
  await reject(market.createTeam(u.captain,{name:'Blocked new team',context:completeContext()},key()),'student_verification_required');
  await reject(market.inviteMember(u.captain,t.id,{userId:u.publisher,...await revision(u.captain,t.id)},key()),'student_verification_required');
  assert.equal((await market.archiveTeam(u.captain,t.id,await revision(u.captain,t.id),key())).status,'archived');
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[u.member]);
  await reject(market.team(u.member,t.id),'account_locked');
  await reject(market.leaveTeam(u.member,t.id,{expectedRevision:1},key()),'account_locked');
});

test('archive requires a sole captain without pending invitations and does not rewrite old relationships',async()=>{
  const u=await people(),t=await teamOf(u);
  await reject(market.archiveTeam(u.captain,t.id,await revision(u.captain,t.id),key()),'team_not_empty');
  await market.removeMember(u.captain,t.id,u.member,await revision(u.captain,t.id),key());
  await invite(u.captain,t.id,u.late);
  await reject(market.archiveTeam(u.captain,t.id,await revision(u.captain,t.id),key()),'team_not_empty');
  await market.revokeInvitation(u.captain,t.id,u.late,await revision(u.captain,t.id),key());
  const archiveBody=await revision(u.captain,t.id),archiveKey=key();
  const archived=await market.archiveTeam(u.captain,t.id,archiveBody,archiveKey);
  assert.equal(archived.status,'archived');assert.ok(archived.archived_at);
  assert.equal((await market.archiveTeam(u.captain,t.id,archiveBody,archiveKey)).revision,archived.revision);
  assert.equal(await membership(t.id,u.member),'removed');assert.equal(await membership(t.id,u.late),'revoked');
  await reject(market.inviteMember(u.captain,t.id,{userId:u.member,...await revision(u.captain,t.id)},key()),'team_archived');
  const task=await publish(u.publisher);
  await reject(market.apply(u.captain,task.id,{proposal:'Archived attempt',teamId:t.id},key()),'team_archived');
});

test('application consent, original signing authority and agreement members survive transfer, removal and later invitations',async()=>{
  const u=await people(),t=await teamOf(u),task=await publish(u.publisher);
  const application=await market.apply(u.captain,task.id,{proposal:'Frozen original participants',teamId:t.id},key());
  await market.consentApplication(u.member,application.id,{},key());
  const frozen=(await f.owner.query('SELECT user_id,confirmed FROM campus.application_members WHERE application_id=$1 ORDER BY user_id',[application.id])).rows;
  await market.transferCaptain(u.captain,t.id,{userId:u.member,...await revision(u.captain,t.id)},key());
  await market.leaveTeam(u.captain,t.id,await revision(u.captain,t.id),key());
  await invite(u.member,t.id,u.late);await accept(u.late,t.id);
  assert.deepEqual((await f.owner.query('SELECT user_id,confirmed FROM campus.application_members WHERE application_id=$1 ORDER BY user_id',[application.id])).rows,frozen);
  await market.inviteApplicant(u.publisher,application.id,{},key());
  await reject(market.acceptInvitation(u.member,application.id,{},key()),'not_captain');
  const agreement=await market.acceptInvitation(u.captain,application.id,{},key());
  const before=await market.agreement(u.captain,agreement.id);
  assert.equal(before.captain_id,u.captain);assert.deepEqual(before.members.map(x=>x.user_id).sort(),[u.captain,u.member].sort());
  assert.deepEqual(before.terms.members.slice().sort(),[u.captain,u.member].sort());
  await reject(market.agreement(u.late,agreement.id),'not_found');
  await market.sendMessage(u.captain,{agreementId:agreement.id,body:'Still a recorded participant'},key());
  assert.equal((await market.messages(u.member,{agreementId:agreement.id}))[0].body,'Still a recorded participant');
  await market.transferCaptain(u.member,t.id,{userId:u.late,...await revision(u.member,t.id)},key());
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  await market.archiveTeam(u.late,t.id,await revision(u.late,t.id),key());
  assert.deepEqual((await market.agreement(u.member,agreement.id)).terms,before.terms);
  await reject(market.messages(u.late,{agreementId:agreement.id}),'not_found');
});

test('competing accept versus revoke and transfer versus removal serialize to one revision winner',async()=>{
  for(let i=0;i<3;i++) {
    const u=await people(),t=await teamOf(u,false);
    await invite(u.captain,t.id,u.member);const body=await revision(u.captain,t.id);
    const outcomes=await Promise.allSettled([
      market.acceptMembership(u.member,t.id,body,key()),
      market.revokeInvitation(u.captain,t.id,u.member,body,key()),
    ]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='team_revision_changed').length,1);
    assert.equal((await market.team(u.captain,t.id)).revision,body.expectedRevision+1);
    if(await membership(t.id,u.member)==='revoked') { await invite(u.captain,t.id,u.member);await accept(u.member,t.id); }
    const next=await revision(u.captain,t.id);
    const transfer=await Promise.allSettled([
      market.transferCaptain(u.captain,t.id,{userId:u.member,...next},key()),
      market.removeMember(u.captain,t.id,u.member,next,key()),
    ]);
    assert.equal(transfer.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(transfer.filter(x=>x.status==='rejected'&&['team_revision_changed','not_owner'].includes(x.reason.code)).length,1);
    const row=(await f.owner.query('SELECT owner_id,revision FROM campus.teams WHERE id=$1',[t.id])).rows[0];
    assert.equal(row.revision,next.expectedRevision+1);
    assert.equal(await membership(t.id,row.owner_id),'accepted');
  }
});

test('captain eligibility hints do not disclose peer eligibility to invited or ordinary members',async()=>{
  const u=await people(),t=await teamOf(u);
  await invite(u.captain,t.id,u.late);
  const captain=await market.team(u.captain,t.id);
  assert.equal(captain.members.find(x=>x.user_id===u.member).can_captain,true);
  for(const actor of [u.member,u.late]) {
    const view=await market.team(actor,t.id);
    assert.ok(view.members.every(x=>x.can_captain===false));
    await store.as(actor,async c=>assert.ok((await c.query('SELECT * FROM campus.team_people($1)',[t.id])).rows.every(x=>x.can_captain===false)));
  }
});

async function waitForTeamWaiters(id,count) {
  // Restricted owner can observe lock identities; no query text or extra role grant is needed.
  for(let i=0;i<100;i++) {
    const row=(await f.owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND NOT granted
      AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
      AND objid=(hashtextextended($1,0)&4294967295)::oid`,['team:'+id])).rows[0];
    if(row.n>=count) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Expected queued team lock waiters');
}

test('forced apply-versus-leave lock ordering freezes exactly the serialized membership snapshot',async()=>{
  for(const applicationFirst of [true,false]) {
    const u=await people(),t=await teamOf(u),task=await publish(u.publisher);
    const body=await revision(u.member,t.id);
    await f.owner.query('BEGIN');
    await f.owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['team:'+t.id]);
    const apply=()=>market.apply(u.captain,task.id,{proposal:'Lock-ordered snapshot',teamId:t.id},key());
    const leave=()=>market.leaveTeam(u.member,t.id,body,key());
    let first,second;
    try {
      first=(applicationFirst?apply:leave)();
      await waitForTeamWaiters(t.id,1);
      second=(applicationFirst?leave:apply)();
      await waitForTeamWaiters(t.id,2);
    } finally { await f.owner.query('COMMIT'); }
    const outcomes=await Promise.all([first,second]);
    const application=outcomes[applicationFirst?0:1];
    const members=(await f.owner.query('SELECT user_id FROM campus.application_members WHERE application_id=$1 ORDER BY user_id',[application.id])).rows.map(x=>x.user_id);
    assert.deepEqual(members,applicationFirst?[u.captain,u.member].sort():[u.captain]);
    assert.equal(await membership(t.id,u.member),'left');
  }
});

test('membership history cannot be edited even through the disposable fixture owner',async()=>{
  const u=await people(),t=await teamOf(u);
  await assert.rejects(f.owner.query("UPDATE campus.team_membership_events SET state='removed' WHERE team_id=$1",[t.id]),{code:'23514'});
  await assert.rejects(f.owner.query('DELETE FROM campus.team_membership_events WHERE team_id=$1',[t.id]),{code:'23514'});
  await store.as(u.member,async c=>assert.equal((await c.query('SELECT campus.on_team($1) AS value',[t.id])).rows[0].value,true));
  await market.leaveTeam(u.member,t.id,await revision(u.member,t.id),key());
  await store.as(u.member,async c=>assert.equal((await c.query('SELECT campus.on_team($1) AS value',[t.id])).rows[0].value,false));
});
