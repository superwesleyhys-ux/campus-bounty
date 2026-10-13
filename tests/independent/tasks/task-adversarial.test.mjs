import test from 'node:test';
import { completeContext } from '../team-context-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo=process.env.CAMPUS_REVIEW_REPO ? pathToFileURL(resolve(process.env.CAMPUS_REVIEW_REPO)+'/') : new URL('../../../',import.meta.url);
const {fixture}=await import(new URL('tests/backend/fixture.mjs',repo));
const {createStore}=await import(new URL('backend/db/store.mjs',repo));
const {createMarket}=await import(new URL('backend/modules/market.mjs',repo));

const f = await fixture();
const store = createStore(f.urls), market = createMarket(store);
await store.verifyRoles();
console.log(JSON.stringify({runtime:process.version,database:(await f.owner.query('SELECT version() AS version')).rows[0].version,reviewSourceCandidate:'5ef1b68b55352786de7ef19895833c9f70936824'}));
test.after(async()=>{await store.close();await f.close();});
const key=()=>randomUUID();
const body={title:'Independent task audit',category:'Research',description:'Synthetic local fixture',rewardCents:10000,milestones:[{title:'Dataset',amountCents:4000,deliverable:'Data'},{title:'Report',amountCents:6000,deliverable:'Report'}]};
const fail=(promise,code)=>assert.rejects(promise,e=>e.code===code,`Expected ${code}`);
const ids=async()=>({owner:await f.user('Owner'),captain:await f.user('Captain'),member:await f.user('Member'),late:await f.user('Late member'),stranger:await f.user('Stranger')});
const publish=owner=>market.publishTask(owner,body,key());
const apply=(actor,task,teamId=null)=>market.apply(actor,task.id,{proposal:'We consent only to this proposal.',teamId},key());
const revision=async(actor,id)=>({expectedRevision:(await market.team(actor,id)).revision});
async function teamOf(captain,member){const t=await market.createTeam(captain,{name:'Local research team',context:completeContext()},key());await market.inviteMember(captain,t.id,{userId:member,...await revision(captain,t.id)},key());await market.acceptMembership(member,t.id,await revision(member,t.id),key());return t;}

test('each application requires its own consent, and later accepted teammates remain outside existing participant snapshot',async()=>{
 const u=await ids(),team=await teamOf(u.captain,u.member);
 await market.inviteMember(u.captain,team.id,{userId:u.late,...await revision(u.captain,team.id)},key());
 const t1=await publish(u.owner),a1=await apply(u.captain,t1,team.id);
 await fail(market.inviteApplicant(u.owner,a1.id,{},key()),'team_consent_required');
 await fail(market.consentApplication(u.stranger,a1.id,{},key()),'not_found');
 await market.consentApplication(u.member,a1.id,{},key());
 await market.acceptMembership(u.late,team.id,await revision(u.late,team.id),key());
 await fail(market.consentApplication(u.late,a1.id,{},key()),'not_found');
 const t2=await publish(u.owner),a2=await apply(u.captain,t2,team.id);
 await fail(market.inviteApplicant(u.owner,a2.id,{},key()),'team_consent_required');
 await market.consentApplication(u.member,a2.id,{},key());
 await fail(market.inviteApplicant(u.owner,a2.id,{},key()),'team_consent_required');
 await market.consentApplication(u.late,a2.id,{},key());
 await market.inviteApplicant(u.owner,a2.id,{},key());
 await market.inviteApplicant(u.owner,a1.id,{},key());
 await fail(market.acceptInvitation(u.member,a1.id,{},key()),'not_captain');
 const a=await market.acceptInvitation(u.captain,a1.id,{},key());
 const view=await market.agreement(u.member,a.id), expected=[u.captain,u.member].sort();
 assert.deepEqual(view.members.map(x=>x.user_id).sort(),expected);
 assert.deepEqual(view.terms.members.slice().sort(),expected);
 await fail(market.agreement(u.late,a.id),'not_found');
 await fail(market.agreement(u.stranger,a.id),'not_found');
 await fail(market.submitMilestone(u.member,view.milestones[0].id,{content:'No funding',expectedVersion:0,expectedRevision:1},key()),'funding_required');
 // Administrative state change is an isolated test fixture; no public funding API exists.
 await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1",[a.id]);
 await fail(market.submitMilestone(u.late,view.milestones[0].id,{content:'Late member',expectedVersion:0,expectedRevision:1},key()),'not_found');
 const sub=await market.submitMilestone(u.member,view.milestones[0].id,{content:'Frozen member allowed',expectedVersion:0,expectedRevision:1},key());
 assert.equal(sub.submission.version,1);
 assert.equal((await market.agreement(u.captain,a.id)).members.length,2);
});

test('publisher exclusion, captain-only application and invited-only membership are enforced through service',async()=>{
 const u=await ids(),team=await teamOf(u.captain,u.member),t=await publish(u.owner);
 await fail(apply(u.member,t,team.id),'not_captain');
 await fail(market.acceptMembership(u.stranger,team.id,await revision(u.captain,team.id),key()),'not_found');
 await market.inviteMember(u.captain,team.id,{userId:u.owner,...await revision(u.captain,team.id)},key());
 await market.acceptMembership(u.owner,team.id,await revision(u.owner,team.id),key());
 await fail(apply(u.captain,t,team.id),'self_application');
 const count=(await f.owner.query('SELECT count(*)::int AS n FROM campus.applications WHERE task_id=$1',[t.id])).rows[0].n;
 assert.equal(count,0);
});

test('invalid budgets and unknown fields leave no tasks; accepted contract copies exact maximum allowed total',async()=>{
 const u=await ids();
 const before=(await f.owner.query('SELECT count(*)::int AS n FROM campus.tasks')).rows[0].n;
 await fail(market.publishTask(u.owner,{...body,rewardCents:9999},key()),'invalid_milestone_budget');
 await assert.rejects(market.publishTask(u.owner,{...body,milestones:[{...body.milestones[0],amountCents:0}]},key()));
 await assert.rejects(market.publishTask(u.owner,{...body,milestones:[{...body.milestones[0],amountCents:1.5}]},key()));
 await assert.rejects(market.publishTask(u.owner,{...body,ownerId:u.stranger},key()));
 assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.tasks')).rows[0].n,before);
 const data={...body,rewardCents:100000000,milestones:Array.from({length:20},(_,i)=>({title:`Milestone ${i+1}`,amountCents:5000000,deliverable:'Exact terms'}))};
 const t=await market.publishTask(u.owner,data,key()),app=await apply(u.captain,t);
 await market.inviteApplicant(u.owner,app.id,{},key());
 const a=await market.acceptInvitation(u.captain,app.id,{},key()),view=await market.agreement(u.owner,a.id);
 assert.equal(view.milestones.length,20);
 assert.equal(view.milestones.reduce((s,m)=>s+m.amount_cents,0),100000000);
 assert.equal(view.terms.rewardCents,100000000);
 assert.deepEqual(view.terms.milestones.map(({position,title,amount_cents,deliverable})=>({position,title,amount_cents,deliverable})),view.milestones.map(({position,title,amount_cents,deliverable})=>({position,title,amount_cents,deliverable})));
 await assert.rejects(f.owner.query("UPDATE campus.agreements SET terms='{}' WHERE id=$1",[a.id]),e=>e.code==='23514');
 await assert.rejects(f.owner.query('UPDATE campus.milestones SET amount_cents=1 WHERE id=$1',[view.milestones[0].id]),e=>e.code==='23514');
});

test('five distinct simultaneous accept keys and repeated same key create a single agreement with one participant set',async()=>{
 const u=await ids(),t=await publish(u.owner),a=await apply(u.captain,t);
 await market.inviteApplicant(u.owner,a.id,{},key());
 const same=key(),r=await Promise.all([same,same,key(),key(),key()].map(k=>market.acceptInvitation(u.captain,a.id,{},k)));
 assert.equal(new Set(r.map(x=>x.id)).size,1);
 const rows=await f.owner.query('SELECT id FROM campus.agreements WHERE task_id=$1',[t.id]);
 assert.equal(rows.rowCount,1);
 assert.equal((await f.owner.query('SELECT * FROM campus.agreement_members WHERE agreement_id=$1',[r[0].id])).rowCount,1);
 const pubkey=key(); const [p1,p2]=await Promise.all([market.publishTask(u.owner,body,pubkey),market.publishTask(u.owner,body,pubkey)]);
 assert.equal(p1.id,p2.id);
 await fail(market.publishTask(u.owner,{...body,title:'Changed content'},pubkey),'idempotency_conflict');
});

test('three invited competitors produce one winner, and no late application or invitation succeeds',async()=>{
 const u=await ids();
 for(let round=0;round<5;round++){
  const t=await publish(u.owner),actors=[u.captain,u.member,u.stranger];
  const apps=await Promise.all(actors.map(actor=>apply(actor,t)));
  await Promise.all(apps.map(a=>market.inviteApplicant(u.owner,a.id,{},key())));
  const rs=await Promise.allSettled(apps.map((a,i)=>market.acceptInvitation(actors[i],a.id,{},key())));
  assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(rs.filter(r=>r.status==='rejected'&&r.reason.code==='task_contracted').length,2);
  assert.equal((await f.owner.query('SELECT * FROM campus.agreements WHERE task_id=$1',[t.id])).rowCount,1);
  await fail(apply(u.late,t),'invalid_state');
  await fail(market.inviteApplicant(u.owner,apps[0].id,{},key()),'invalid_state');
 }
});

test('concurrent milestone writers preserve one version; owner cannot submit, members cannot accept, stale acceptance cannot select old content',async()=>{
 const u=await ids(),team=await teamOf(u.captain,u.member),t=await publish(u.owner),app=await apply(u.captain,t,team.id);
 await market.consentApplication(u.member,app.id,{},key());await market.inviteApplicant(u.owner,app.id,{},key());
 const a=await market.acceptInvitation(u.captain,app.id,{},key());await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1",[a.id]);
 const m=(await market.agreement(u.owner,a.id)).milestones[0];
 await fail(market.submitMilestone(u.owner,m.id,{content:'Publisher cannot act as assignee',expectedVersion:0,expectedRevision:1},key()),'not_assignee');
 const rs=await Promise.allSettled([u.captain,u.member].map((actor,i)=>market.submitMilestone(actor,m.id,{content:`Writer ${i}`,expectedVersion:0,expectedRevision:1},key())));
 assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);assert.equal(rs.filter(r=>r.status==='rejected'&&r.reason.code==='stale_revision').length,1);
 const first=rs.find(r=>r.status==='fulfilled').value;
 const second=await market.submitMilestone(u.member,m.id,{content:'Second version',expectedVersion:1,expectedRevision:2},key());
 await fail(market.acceptMilestone(u.owner,m.id,{submissionId:first.receipt.submissionId,expectedVersion:1,expectedRevision:2},key()),'stale_revision');
 await fail(market.acceptMilestone(u.captain,m.id,{submissionId:second.receipt.submissionId,expectedVersion:2,expectedRevision:3},key()),'not_owner');
 const acceptkey=key();const accepted=await market.acceptMilestone(u.owner,m.id,{submissionId:second.receipt.submissionId,expectedVersion:2,expectedRevision:3},acceptkey);
 assert.equal(accepted.milestone.state,'accepted');assert.equal(accepted.milestone.version,2);
 assert.deepEqual(await market.acceptMilestone(u.owner,m.id,{submissionId:second.receipt.submissionId,expectedVersion:2,expectedRevision:3},acceptkey),accepted);
 await fail(market.submitMilestone(u.member,m.id,{content:'After acceptance',expectedVersion:2,expectedRevision:4},key()),'invalid_state');
 const submissions=await market.submissions(u.member,m.id);assert.deepEqual(submissions.map(x=>x.version),[1,2]);
 await assert.rejects(f.owner.query("UPDATE campus.submissions SET content='Overwritten' WHERE id=$1",[submissions[0].id]),e=>e.code==='23514');
});
