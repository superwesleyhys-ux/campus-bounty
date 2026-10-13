// Independent verification only; never changes the submitted candidate.
// Run from work/campus-bounty after its isolated local.json adapter is ready:
// node --test ../../repros/rls/rls-context.test.mjs
import test from 'node:test';
import { completeContext } from '../team-context-fixture.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const work = new URL('../../../', import.meta.url);
const require = createRequire(new URL('package.json', work));
const pg = require('pg');
const { fixture } = await import(new URL('tests/backend/fixture.mjs', work));
const { createStore, transaction } = await import(new URL('backend/db/store.mjs', work));
const { createMarket } = await import(new URL('backend/modules/market.mjs', work));
const f = await fixture();
const store = createStore(f.urls);
const market = createMarket(store);
const single = new pg.Pool({connectionString: f.urls.app, max: 1});
const author = await f.user('Independent publisher');
const participant = await f.user('Independent participant');
const stranger = await f.user('Independent outsider');
const key = () => randomUUID();
let team, application, agreement, milestone, order, submission;

test.after(async () => { await single.end(); await store.close(); await f.close(); });

test('independent runtime roles pass startup and definer functions have pinned search paths and restricted grants', async () => {
  await store.verifyRoles();
  const functions = (await f.owner.query(`SELECT p.proname,p.proconfig,
    p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
    has_function_privilege('campus_app',p.oid,'EXECUTE') AS app,
    has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth,
    has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='campus' AND p.prosecdef ORDER BY p.proname`)).rows;
  const notificationInternal = ['emit_notification','notification_agreement_people','notify_application_transition','notify_application_consent','notify_team_event','notify_work_transition','notify_message_insert','notify_order_transition','notify_eligibility_transition'];
  assert.deepEqual(functions.map(fn=>fn.signature).sort(), [
    'authorize_message_scope(text, uuid)','conversation_people(text, uuid)',
    'can_read_application_conversation(uuid)','application_conversation_context(uuid)',
    'emit_notification(text, text, text, uuid, uuid[], uuid)','notification_agreement_people(uuid)',
    'notify_application_transition()','notify_application_consent()','notify_team_event()','notify_work_transition()',
    'notify_message_insert()','notify_order_transition()','notify_eligibility_transition()','mark_notification_read(uuid)',
    'initialize_application_members(uuid)','consent_application_member(uuid)','change_application_state(uuid, text)','accept_task_invitation(uuid)','authorize_work_agreement(uuid, text)','complete_work_agreement(uuid)','review_milestone_work(uuid, uuid, integer, integer, text, text)','submit_milestone_work(uuid, integer, integer, text)','application_people(uuid)','can_review_eligibility(uuid)','cancel_unpaid_order(uuid)',
    'captains_application(uuid)','change_team(uuid, text, uuid, integer)',
    'create_order_from_quote(uuid, jsonb)','create_team(text)','create_team_with_context(text, jsonb)',
    'decide_student_eligibility(uuid, text, text, timestamp with time zone)',
    'eligibility_requests_visible()','eligible_student(uuid)','expire_reservations()',
    'in_agreement(uuid)','in_application(uuid)','in_milestone(uuid)','in_order(uuid)',
    'is_member()','on_team(uuid)','owns_task(uuid)','owns_team(uuid)',
    'request_student_eligibility(text, boolean)','set_team_context(uuid, integer, jsonb)','supersede_other_applications(uuid)',
    'team_candidate(uuid, uuid)','team_people(uuid)','team_roster_visible(uuid)','teams_visible()',
  ].sort());
  for (const fn of functions) {
    // Inventory and eligibility functions put the temporary schema last, as
    // PostgreSQL recommends for SECURITY DEFINER. Keep an exact trusted path
    // for each version; do not accept arbitrary paths or weaken ACL assertions.
    const explicitTemporarySchema = [...notificationInternal,'can_read_application_conversation','application_conversation_context','authorize_message_scope','conversation_people','mark_notification_read','initialize_application_members','consent_application_member','change_application_state','accept_task_invitation','authorize_work_agreement','complete_work_agreement','review_milestone_work','submit_milestone_work','in_agreement','create_order_from_quote','cancel_unpaid_order',
      'can_review_eligibility','eligible_student','eligibility_requests_visible',
      'request_student_eligibility','decide_student_eligibility',
      'change_team','create_team','create_team_with_context','set_team_context','on_team','team_candidate','team_people',
      'team_roster_visible','teams_visible'].includes(fn.proname);
    const expectedPath = explicitTemporarySchema ? 'search_path=pg_catalog, campus, pg_temp' : 'search_path=pg_catalog, campus';
    assert.ok(fn.proconfig.includes(expectedPath), fn.proname);
    assert.equal(fn.public_execute, false, fn.proname);
    assert.equal(fn.auth, false, fn.proname);
    assert.equal(fn.app, fn.proname !== 'expire_reservations' && !notificationInternal.includes(fn.proname), fn.proname);
    assert.equal(fn.worker, fn.proname === 'expire_reservations', fn.proname);
  }
  // The message insert guard is a private invoker trigger, not an extra definer.
  const guards = (await f.owner.query(`SELECT p.prosecdef,p.proconfig,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
    has_function_privilege('campus_app',p.oid,'EXECUTE') AS app,
    has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth,
    has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker
    FROM pg_catalog.pg_proc p WHERE p.oid='campus.guard_message_send()'::regprocedure`)).rows;
  assert.deepEqual(guards,[{prosecdef:false,proconfig:['search_path=pg_catalog, campus, pg_temp'],public_execute:false,app:false,auth:false,worker:false}]);
});

async function contextSnapshot(c) {
  return (await c.query(`SELECT pg_backend_pid() AS pid, campus.actor() AS actor,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout,
    (SELECT array_agg(id::text ORDER BY id) FROM campus.users) AS users`)).rows[0];
}

test('same physical pooled connection clears actor after commit and both application and SQL rollback', async () => {
  const before = await single.query(`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout`);
  const pid = before.rows[0].pid;
  const assertClean = async () => {
    const clean = await contextSnapshot(single);
    assert.equal(clean.pid, pid);
    assert.equal(clean.actor, null);
    assert.equal(clean.users, null);
    assert.equal(clean.statement_timeout, before.rows[0].statement_timeout);
    assert.equal(clean.lock_timeout, before.rows[0].lock_timeout);
  };
  const successful = await transaction(single, author, contextSnapshot);
  assert.equal(successful.pid, pid);
  assert.equal(successful.actor, author);
  assert.deepEqual(successful.users, [author]);
  assert.equal(successful.statement_timeout, '8s');
  assert.equal(successful.lock_timeout, '3s');
  await assertClean();
  await assert.rejects(transaction(single, participant, async (c) => {
    assert.equal((await contextSnapshot(c)).actor, participant);
    throw new Error('intentional callback rollback');
  }), /intentional callback rollback/);
  await assertClean();
  await assert.rejects(transaction(single, participant, c => c.query('SELECT 1/0')), {code:'22012'});
  await assertClean();
  assert.equal((await transaction(single, null, contextSnapshot)).actor, null);
  await assertClean();
});

test('concurrent pooled actor calls remain isolated before and after query overlaps', async () => {
  const actors = [author, participant, stranger];
  await Promise.all(Array.from({length:24}, (_,i) => store.as(actors[i%3], async c => {
    const first = await contextSnapshot(c);
    await c.query('SELECT pg_sleep(0.005)');
    const last = await contextSnapshot(c);
    assert.equal(first.actor, actors[i%3]);
    assert.equal(last.actor, actors[i%3]);
    assert.deepEqual(last.users, [actors[i%3]]);
  })));
  const clients = await Promise.all(Array.from({length:5},()=>store.app.connect()));
  try {
    for (const c of clients) assert.equal((await contextSnapshot(c)).actor, null);
  } finally { for (const c of clients) c.release(); }
});

test('app/auth/worker ACL separation denies identity, business and privileged function access across roles', async () => {
  const deny = (pool, sql) => assert.rejects(pool.query(sql), {code:'42501'});
  for (const table of ['identities','challenges','sessions','mail_jobs']) await deny(store.app, `SELECT * FROM campus.${table}`);
  for (const table of ['orders','messages','agreements']) {
    await deny(store.auth, `SELECT * FROM campus.${table}`);
    await deny(store.worker, `SELECT * FROM campus.${table}`);
  }
  await deny(store.app,'SELECT campus.expire_reservations()');
  await deny(store.auth,'SELECT campus.expire_reservations()');
  await deny(store.worker,'SELECT campus.is_member()');
  await deny(store.app,'CREATE TABLE campus.independent_forbidden(id integer)');
});

test('service-created private task/goods rows stay invisible to unrelated actor even with omitted SQL object filters', async () => {
  team = await market.createTeam(participant,{name:'Independent team',context:completeContext()},key());
  const task = await market.publishTask(author,{title:'Independent audit',category:'Research',description:'Synthetic test',rewardCents:100,milestones:[{title:'Report',amountCents:100,deliverable:'Report'}]},key());
  application = await market.apply(participant,task.id,{proposal:'Audit',teamId:team.id},key());
  await market.inviteApplicant(author,application.id,{},key());
  agreement = await market.acceptInvitation(participant,application.id,{},key());
  milestone = (await market.agreement(participant,agreement.id)).milestones[0];
  // Fixture-only funding; no public payment capability exists in the candidate.
  await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1",[agreement.id]);
  submission = (await market.submitMilestone(participant,milestone.id,{content:'Private research',expectedVersion:0,expectedRevision:1},key())).submission;
  await market.sendMessage(participant,{agreementId:agreement.id,body:'Private agreement message'},key());
  const product = await market.publishProduct(author,{title:'Independent goods',description:'Synthetic test',priceCents:100,stock:2,deliveryMethods:['shipping'],shippingCents:0},key());
  const quote = await market.quote(participant,product.id,{quantity:1,deliveryMethod:'shipping'},key());
  order = await market.order(participant,{quoteId:quote.id,shippingAddress:{name:'Synthetic recipient',line1:'1 Test Road',city:'Test',region:'CA',postalCode:'00000',country:'US'}},key());
  await market.sendMessage(participant,{orderId:order.id,body:'Private order message'},key());
  for (const actor of [stranger,null]) {
    await store.as(actor,async c => {
      for (const table of ['teams','team_members','applications','application_members','agreements','agreement_members','milestones','submissions','quotes','orders','messages','idempotency']) {
        assert.equal((await c.query(`SELECT * FROM campus.${table}`)).rowCount,0,`${table}: ${actor || 'missing actor'}`);
      }
    });
  }
  assert.equal((await market.messages(author,{orderId:order.id}))[0].body,'Private order message');
  assert.equal((await market.getOrder(author,order.id)).shipping_address.line1,'1 Test Road');
});

test('new team invite after agreement creation grants team visibility but no historical agreement participation', async () => {
  await market.inviteMember(participant,team.id,{userId:stranger,expectedRevision:(await market.team(participant,team.id)).revision},key());
  await market.acceptMembership(stranger,team.id,{expectedRevision:(await market.team(stranger,team.id)).revision},key());
  assert.equal((await market.team(stranger,team.id)).id,team.id);
  for (const fn of [() => market.agreement(stranger,agreement.id),() => market.submissions(stranger,milestone.id),() => market.messages(stranger,{agreementId:agreement.id})]) {
    await assert.rejects(fn(), e => e.code==='not_found');
  }
  assert.deepEqual((await market.agreement(participant,agreement.id)).members.map(m=>m.user_id),[participant]);
});

test('expired participant retains private history while a security-locked participant is denied by service account gate', async () => {
  await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",[participant]);
  assert.equal((await market.agreement(participant,agreement.id)).id,agreement.id);
  assert.equal((await market.getOrder(participant,order.id)).id,order.id);
  assert.equal((await market.submissions(participant,milestone.id))[0].id,submission.id);
  assert.equal((await market.messages(participant,{agreementId:agreement.id})).length,1);
  await assert.rejects(market.tasks(participant,{}),e=>e.code==='membership_required');
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[participant]);
  for (const fn of [() => market.agreement(participant,agreement.id),() => market.getOrder(participant,order.id),() => market.messages(participant,{orderId:order.id})]) await assert.rejects(fn(),e=>e.code==='account_locked');
});
