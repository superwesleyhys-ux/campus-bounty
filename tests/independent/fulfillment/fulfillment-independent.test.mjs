// Independent review assertions for round 6. Real, disposable PostgreSQL only.
// Funding below is an owner-only fixture transition; no payment system is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as key } from 'node:crypto';
import pg from 'pg';
import { connectionString } from '../../../scripts/backend-local.mjs';
import { fixture } from '../../backend/fixture.mjs';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';
import { completeContext } from '../team-context-fixture.mjs';

const f = await fixture(), store = createStore(f.urls), market = createMarket(store);
test.after(async () => { await store.close(); await f.close(); });
const rejects = (promise, code) => assert.rejects(promise, { code });
const tuple = (m, submission) => ({
  submissionId: submission.id,
  expectedVersion: submission.version,
  expectedRevision: m.revision,
});
const current = async (u, id, milestoneId) =>
  (await market.agreement(u, id)).milestones.find(m => m.id === milestoneId);

async function scenario({ count = 1, team = false, funded = true } = {}) {
  const publisher = await f.user('Independent fulfillment publisher');
  const captain = await f.user('Independent fulfillment captain');
  const member = await f.user('Independent fulfillment member');
  const outsider = await f.user('Independent fulfillment outsider');
  let group;
  if (team) {
    group = await market.createTeam(captain, { name: 'Independent delivery group', context: completeContext() }, key());
    await market.inviteMember(captain, group.id, { userId: member, expectedRevision: group.revision }, key());
    group = await market.acceptMembership(member, group.id, { expectedRevision: group.revision + 1 }, key());
  }
  const task = await market.publishTask(publisher, {
    title: 'Independent delivery review', category: 'Research', description: 'Synthetic fulfillment audit only', rewardCents: count * 100,
    milestones: Array.from({ length: count }, (_, i) => ({ title: `Phase ${i + 1}`, amountCents: 100, deliverable: `Summary ${i + 1}`, acceptanceCriteria: 'Cite the synthetic source.' })),
  }, key());
  const application = await market.apply(captain, task.id, { proposal: 'Synthetic audit proposal', teamId: group?.id ?? null }, key());
  if (team) await market.consentApplication(member, application.id, {}, key());
  await market.inviteApplicant(publisher, application.id, {}, key());
  const agreement = await market.acceptInvitation(captain, application.id, {}, key());
  if (funded) await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [agreement.id]);
  const view = await market.agreement(captain, agreement.id);
  return { publisher, captain, member, outsider, group, task, application, agreement: view, milestones: view.milestones };
}
const submit = (u, m, content = 'Synthetic source summary', requestKey = key()) =>
  market.submitMilestone(u, m.id, { content, expectedVersion: m.version, expectedRevision: m.revision }, requestKey);
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
async function waitForAgreementQueue(id, count = 1) {
  for (let n = 0; n < 100; n++) {
    const result = await f.owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_locks
      WHERE locktype='advisory' AND NOT granted
      AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
      AND objid=(hashtextextended($1,0)&4294967295)::oid`, ['agreement:' + id]);
    if (result.rows[0].n >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected a real agreement lock waiter');
}

test('revision request anchors immutable feedback to one exact submission, resubmission advances separately, acceptance completes only final work', async () => {
  const s = await scenario(), m = s.milestones[0];
  assert.equal(m.revision, 1); assert.equal(m.version, 0);
  const first = await submit(s.captain, m, 'First draft');
  assert.equal(first.milestone.revision, 2); assert.equal(first.submission.version, 1);
  assert.equal(first.milestone.latest_submission_id, first.submission.id);
  const requested = await market.requestMilestoneRevision(s.publisher, m.id, { ...tuple(first.milestone, first.submission), feedback: '  Please add the source citation.  ' }, key());
  assert.equal(requested.milestone.state, 'revision_requested');
  assert.equal(requested.milestone.revision, 3); assert.equal(requested.milestone.version, 1);
  const history = await market.milestoneReviews(s.captain, m.id);
  assert.equal(history.length, 1); assert.equal(history[0].submission_id, first.submission.id);
  assert.equal(history[0].submission_version, 1); assert.equal(history[0].milestone_revision, 3);
  assert.equal(history[0].reviewer_id, s.publisher); assert.equal(history[0].decision, 'revision_requested');
  assert.equal(history[0].feedback, 'Please add the source citation.');
  await rejects(market.acceptMilestone(s.publisher, m.id, tuple(requested.milestone, first.submission), key()), 'invalid_state');
  const second = await submit(s.captain, requested.milestone, 'Second draft with citation');
  assert.equal(second.submission.version, 2); assert.equal(second.milestone.revision, 4);
  await rejects(market.acceptMilestone(s.publisher, m.id, tuple(first.milestone, first.submission), key()), 'stale_revision');
  const accepted = await market.acceptMilestone(s.publisher, m.id, tuple(second.milestone, second.submission), key());
  assert.equal(accepted.milestone.state, 'accepted'); assert.equal(accepted.milestone.revision, 5);
  assert.equal(accepted.milestone.accepted_submission_id, second.submission.id);
  assert.equal(accepted.agreement.state, 'completed');
  assert.deepEqual((await market.submissions(s.captain, m.id)).map(x => x.content), ['First draft', 'Second draft with citation']);
  const all = await market.milestoneReviews(s.captain, m.id);
  assert.equal(all.length, 2); assert.deepEqual(all[0], history[0]);
  assert.equal(all[1].submission_id, second.submission.id); assert.equal(all[1].decision, 'accepted');
});

test('all three review anchors are mandatory and wrong cross-milestone, version, or revision targets cause no write', async () => {
  const s = await scenario({ count: 2 });
  const a = await submit(s.captain, s.milestones[0]);
  const b = await submit(s.captain, s.milestones[1]);
  const good = tuple(a.milestone, a.submission);
  for (const patch of [{ submissionId: b.submission.id }, { expectedVersion: 2 }, { expectedRevision: 1 }]) {
    await rejects(market.acceptMilestone(s.publisher, a.milestone.id, { ...good, ...patch }, key()), 'stale_revision');
    await rejects(market.requestMilestoneRevision(s.publisher, a.milestone.id, { ...good, ...patch, feedback: 'Correct this version' }, key()), 'stale_revision');
  }
  for (const field of ['submissionId', 'expectedVersion', 'expectedRevision']) {
    const missing = { ...good }; delete missing[field];
    await rejects(market.acceptMilestone(s.publisher, a.milestone.id, missing, key()), 'invalid_input');
  }
  assert.deepEqual(await market.milestoneReviews(s.publisher, a.milestone.id), []);
  assert.deepEqual(await current(s.captain, s.agreement.id, a.milestone.id), a.milestone);
});

test('one accepted milestone leaves the agreement active; simultaneous final acceptances finish exactly once without deadlock', async () => {
  const s = await scenario({ count: 3 });
  const submissions = await Promise.all(s.milestones.map(m => submit(s.captain, m)));
  const first = await market.acceptMilestone(s.publisher, submissions[0].milestone.id, tuple(submissions[0].milestone, submissions[0].submission), key());
  assert.equal(first.agreement.state, 'active');
  await rejects(market.completeAgreement(s.publisher, s.agreement.id, {}, key()), 'invalid_state');
  const final = await Promise.all(submissions.slice(1).map(r => market.acceptMilestone(s.publisher, r.milestone.id, tuple(r.milestone, r.submission), key())));
  assert.ok(final.some(r => r.agreement.state === 'completed'));
  const view = await market.agreement(s.publisher, s.agreement.id);
  assert.equal(view.state, 'completed'); assert.ok(view.milestones.every(m => m.state === 'accepted'));
  for (const m of view.milestones) assert.equal((await market.milestoneReviews(s.publisher, m.id)).length, 1);
});

test('simultaneous acceptance versus newer submission has one winner and no approval of unseen content', async () => {
  const s = await scenario(), initial = await submit(s.captain, s.milestones[0]);
  const results = await Promise.allSettled([
    submit(s.captain, initial.milestone, 'Replacement not yet reviewed'),
    market.acceptMilestone(s.publisher, initial.milestone.id, tuple(initial.milestone, initial.submission), key()),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const failed = results.find(x => x.status === 'rejected').reason;
  assert.ok(['stale_revision', 'invalid_state'].includes(failed.code), failed.code);
  const view = await market.agreement(s.publisher, s.agreement.id), m = view.milestones[0];
  const reviews = await market.milestoneReviews(s.publisher, m.id);
  if (m.state === 'accepted') {
    assert.equal(m.accepted_submission_id, initial.submission.id); assert.equal(m.version, 1);
    assert.equal(reviews.length, 1); assert.equal(view.state, 'completed');
  } else {
    assert.equal(m.state, 'submitted'); assert.equal(m.version, 2); assert.equal(m.accepted_submission_id, null);
    assert.equal(reviews.length, 0); assert.equal(view.state, 'active');
  }
});

test('same-key recovery preserves operation receipt but returns current submission, milestone, agreement and no duplicated history', async () => {
  const s = await scenario(), m = s.milestones[0], sk = key(), rk = key();
  const first = await submit(s.captain, m, 'Retry-safe first draft', sk);
  const rb = { ...tuple(first.milestone, first.submission), feedback: 'Add evidence' };
  const reviewed = await market.requestMilestoneRevision(s.publisher, m.id, rb, rk);
  const second = await submit(s.captain, reviewed.milestone, 'Revised draft');
  await market.acceptMilestone(s.publisher, m.id, tuple(second.milestone, second.submission), key());
  const replay = await submit(s.captain, m, 'Retry-safe first draft', sk);
  assert.equal(replay.receipt.submissionId, first.submission.id);
  assert.equal(replay.submission.id, second.submission.id); assert.equal(replay.milestone.state, 'accepted');
  assert.equal(replay.agreement.state, 'completed');
  const reviewReplay = await market.requestMilestoneRevision(s.publisher, m.id, rb, rk);
  assert.equal(reviewReplay.receipt.reviewId, reviewed.receipt.reviewId);
  assert.equal(reviewReplay.milestone.state, 'accepted'); assert.equal(reviewReplay.agreement.state, 'completed');
  await rejects(submit(s.captain, m, 'Changed body on reused key', sk), 'idempotency_conflict');
  assert.equal((await market.submissions(s.captain, m.id)).length, 2);
  assert.equal((await market.milestoneReviews(s.captain, m.id)).length, 2);
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [s.captain]);
  await assert.rejects(submit(s.captain, m, 'Retry-safe first draft', sk), e => ['account_locked', 'membership_required'].includes(e.code));
});

test('successful submission replay is denied when campus verification naturally expires while waiting for the agreement lock', async () => {
  const s = await scenario(), m = s.milestones[0], requestKey = key();
  await submit(s.captain, m, 'Original replay receipt', requestKey);
  await f.owner.query("UPDATE campus.affiliations SET valid_until=clock_timestamp()+interval '600 milliseconds' WHERE user_id=$1", [s.captain]);
  await f.owner.query('BEGIN');
  await f.owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['agreement:' + s.agreement.id]);
  let replay;
  try {
    replay = settle(submit(s.captain, m, 'Original replay receipt', requestKey));
    await waitForAgreementQueue(s.agreement.id);
    await f.owner.query('SELECT pg_sleep(0.8)');
  } finally { await f.owner.query('COMMIT'); }
  const outcome = await replay;
  assert.equal(outcome.ok, false); assert.equal(outcome.error.code, 'membership_required');
  assert.equal((await market.submissions(s.captain, m.id)).length, 1);
});

test('successful receipt cannot bypass an account security lock committed during agreement wait', async () => {
  const s = await scenario(), m = s.milestones[0], requestKey = key();
  await submit(s.captain, m, 'Private prior work', requestKey);
  await f.owner.query('BEGIN');
  await f.owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['agreement:' + s.agreement.id]);
  let replay;
  try {
    replay = settle(submit(s.captain, m, 'Private prior work', requestKey));
    await waitForAgreementQueue(s.agreement.id);
    await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [s.captain]);
  } finally { await f.owner.query('COMMIT'); }
  const outcome = await replay;
  assert.equal(outcome.ok, false);
  assert.ok(['account_locked', 'not_found'].includes(outcome.error.code), outcome.error.code);
});

test('original agreement members retain fulfillment after leaving; later team members cannot see, submit, or review historical work', async () => {
  const s = await scenario({ team: true }), m = s.milestones[0];
  let group = await market.team(s.captain, s.group.id);
  await market.leaveTeam(s.member, group.id, { expectedRevision: group.revision }, key());
  group = await market.team(s.captain, group.id);
  await market.inviteMember(s.captain, group.id, { userId: s.outsider, expectedRevision: group.revision }, key());
  group = await market.team(s.outsider, group.id);
  await market.acceptMembership(s.outsider, group.id, { expectedRevision: group.revision }, key());
  const submitted = await submit(s.member, m, 'Deliverable after leaving team');
  assert.equal(submitted.submission.author_id, s.member);
  for (const fn of [
    () => market.agreement(s.outsider, s.agreement.id),
    () => market.submissions(s.outsider, m.id),
    () => market.milestoneReviews(s.outsider, m.id),
    () => submit(s.outsider, submitted.milestone),
    () => market.acceptMilestone(s.outsider, m.id, tuple(submitted.milestone, submitted.submission), key()),
  ]) await rejects(fn(), 'not_found');
  await rejects(market.requestMilestoneRevision(s.member, m.id, { ...tuple(submitted.milestone, submitted.submission), feedback: 'Self review' }, key()), 'not_owner');
  await rejects(market.acceptMilestone(s.captain, m.id, tuple(submitted.milestone, submitted.submission), key()), 'not_owner');
  await rejects(submit(s.publisher, submitted.milestone), 'not_assignee');
  assert.deepEqual((await market.agreement(s.member, s.agreement.id)).members.map(x => x.user_id).sort(), [s.member, s.captain].sort());
});

test('unfunded work stays blocked and student-status expiry alone does not remove existing fulfillment authority', async () => {
  const unfunded = await scenario({ funded: false });
  await rejects(submit(unfunded.captain, unfunded.milestones[0]), 'funding_required');
  await rejects(market.completeAgreement(unfunded.publisher, unfunded.agreement.id, {}, key()), 'funding_required');
  const s = await scenario();
  await f.owner.query("UPDATE campus.affiliations SET student_valid_until=now()-interval '1 day' WHERE user_id=$1", [s.captain]);
  const result = await submit(s.captain, s.milestones[0]);
  assert.equal(result.milestone.state, 'submitted');
  await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1", [s.captain]);
  await rejects(submit(s.captain, result.milestone), 'membership_required');
  // Reading original private history remains a separate, less restrictive contract.
  assert.equal((await market.submissions(s.captain, result.milestone.id)).length, 1);
});

test('direct application SQL cannot activate, complete, forge versions, append members or milestones, or mutate immutable review evidence', async () => {
  const s = await scenario({ funded: false }), m = s.milestones[0];
  const attempts = [
    [s.publisher, "UPDATE campus.agreements SET state='active' WHERE id=$1", [s.agreement.id]],
    [s.captain, "UPDATE campus.agreements SET state='completed' WHERE id=$1", [s.agreement.id]],
    [s.captain, "UPDATE campus.milestones SET state='accepted',version=99 WHERE id=$1", [m.id]],
    [s.captain, "INSERT INTO campus.agreement_members(agreement_id,user_id) VALUES($1,$2)", [s.agreement.id, s.outsider]],
    [s.captain, "INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable) VALUES($1,99,'Injected',1,'Injected')", [s.agreement.id]],
    [s.captain, "INSERT INTO campus.submissions(milestone_id,author_id,version,content) VALUES($1,$2,99,'Unreviewed')", [m.id, s.captain]],
    [s.captain, "INSERT INTO campus.agreements(task_id,application_id,owner_id,captain_id,state,terms) VALUES($1,$2,$3,$4,'active','{}')", [s.task.id, s.application.id, s.publisher, s.captain]],
  ];
  for (const [actor, sql, values] of attempts) await rejects(store.as(actor, c => c.query(sql, values)), '42501');
  assert.equal((await market.agreement(s.publisher, s.agreement.id)).state, 'awaiting_funding');
  await f.owner.query("UPDATE campus.agreements SET state='active' WHERE id=$1", [s.agreement.id]);
  const submitted = await submit(s.captain, m);
  await market.requestMilestoneRevision(s.publisher, m.id, { ...tuple(submitted.milestone, submitted.submission), feedback: 'Immutable review' }, key());
  await rejects(f.owner.query("UPDATE campus.submissions SET content='Rewrite' WHERE id=$1", [submitted.submission.id]), '23514');
  await rejects(f.owner.query('DELETE FROM campus.submissions WHERE id=$1', [submitted.submission.id]), '23514');
  const row = (await market.milestoneReviews(s.publisher, m.id))[0];
  await rejects(f.owner.query("UPDATE campus.milestone_reviews SET feedback='Rewrite' WHERE id=$1", [row.id]), '23514');
  await rejects(f.owner.query('DELETE FROM campus.milestone_reviews WHERE id=$1', [row.id]), '23514');
  for (const actor of [s.publisher, s.captain]) {
    await rejects(store.as(actor, c => c.query("INSERT INTO campus.milestone_reviews(milestone_id,submission_id,submission_version,milestone_revision,reviewer_id,decision,feedback) VALUES($1,$2,1,99,$3,'accepted','')", [m.id, submitted.submission.id, s.publisher])), '42501');
  }
  assert.deepEqual((await market.milestoneReviews(s.publisher, m.id))[0], row);
});

test('fulfillment definer ACLs are limited, private lock helper is not callable, and locked/outsider raw review reads remain hidden', async () => {
  const s = await scenario(), result = await submit(s.captain, s.milestones[0]);
  await market.requestMilestoneRevision(s.publisher, result.milestone.id, { ...tuple(result.milestone, result.submission), feedback: 'Private review' }, key());
  const names = ['accept_task_invitation', 'authorize_work_agreement', 'submit_milestone_work', 'review_milestone_work', 'complete_work_agreement'];
  const functions = (await f.owner.query(`SELECT p.proname,p.proconfig,
    has_function_privilege('campus_app',p.oid,'EXECUTE') AS app,
    has_function_privilege('campus_auth',p.oid,'EXECUTE') AS auth,
    has_function_privilege('campus_worker',p.oid,'EXECUTE') AS worker,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='campus' AND p.proname=ANY($1)`, [names])).rows;
  assert.equal(functions.length, names.length);
  for (const fn of functions) {
    assert.equal(fn.app, true, fn.proname); assert.equal(fn.auth, false, fn.proname);
    assert.equal(fn.worker, false, fn.proname); assert.equal(fn.public_execute, false, fn.proname);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, campus, pg_temp'), fn.proname);
  }
  await rejects(store.as(s.captain, c => c.query("SELECT campus.lock_work_agreement($1,'submit')", [s.agreement.id])), '42501');
  for (const pool of [store.auth, store.worker]) await rejects(pool.query('SELECT * FROM campus.milestone_reviews'), '42501');
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1", [s.captain]);
  for (const actor of [s.captain, s.outsider, null]) {
    const rows = await store.as(actor, async c => (await c.query('SELECT * FROM campus.milestone_reviews')).rows);
    assert.deepEqual(rows, []);
  }
});

test('feedback, content, and revision schemas reject empty, oversized, extra, fractional, and missing values without partial state', async () => {
  const s = await scenario(), m = s.milestones[0];
  for (const input of [
    { content: '', expectedVersion: 0, expectedRevision: 1 },
    { content: '   ', expectedVersion: 0, expectedRevision: 1 },
    { content: 'x'.repeat(10001), expectedVersion: 0, expectedRevision: 1 },
    { content: 'Valid', expectedVersion: 0, expectedRevision: 0 },
    { content: 'Valid', expectedVersion: 0.5, expectedRevision: 1 },
    { content: 'Valid', expectedVersion: 0 },
    { content: 'Valid', expectedVersion: 0, expectedRevision: 1, state: 'accepted' },
  ]) await rejects(market.submitMilestone(s.captain, m.id, input, key()), 'invalid_input');
  assert.equal((await market.submissions(s.captain, m.id)).length, 0);
  const result = await submit(s.captain, m);
  for (const feedback of ['', '  \n\t ', 'x'.repeat(10001), null, 42]) {
    await rejects(market.requestMilestoneRevision(s.publisher, m.id, { ...tuple(result.milestone, result.submission), feedback }, key()), 'invalid_input');
  }
  assert.equal((await market.milestoneReviews(s.publisher, m.id)).length, 0);
  assert.deepEqual(await current(s.publisher, s.agreement.id, m.id), result.milestone);
});

test('restricted application SQL cannot forge publisher invitation or another participant consent before trusted agreement creation', async () => {
  const s = await scenario({ team: true });
  const publish = () => market.publishTask(s.publisher, { title: 'Fresh proposal trust boundary', category: 'Research', description: 'Synthetic', rewardCents: 100, milestones: [{ title: 'Report', amountCents: 100, deliverable: 'Report' }] }, key());
  const t = await publish();
  const a = await market.apply(s.captain, t.id, { proposal: 'Still needs consent', teamId: s.group.id }, key());
  const blocked = promise => assert.rejects(promise, e => ['42501', '23514', 'P0001'].includes(e.code));
  await blocked(store.as(s.captain, c => c.query("UPDATE campus.applications SET state='invited' WHERE id=$1", [a.id])));
  await blocked(store.as(s.captain, c => c.query('UPDATE campus.application_members SET confirmed=true WHERE application_id=$1 AND user_id=$2', [a.id, s.member])));
  await blocked(store.as(s.captain, c => c.query('INSERT INTO campus.application_members(application_id,user_id,confirmed) VALUES($1,$2,true)', [a.id, s.outsider])));
  const t2 = await publish();
  await blocked(store.as(s.captain, c => c.query("INSERT INTO campus.applications(task_id,applicant_id,proposal,state) VALUES($1,$2,'Forged invitation','invited')", [t2.id, s.captain])));
  await rejects(market.acceptInvitation(s.captain, a.id, {}, key()), 'invalid_state');
  await rejects(market.inviteApplicant(s.publisher, a.id, {}, key()), 'team_consent_required');
  await market.consentApplication(s.member, a.id, {}, key());
  await market.inviteApplicant(s.publisher, a.id, {}, key());
  const agreement = await market.acceptInvitation(s.captain, a.id, {}, key());
  const view = await market.agreement(s.member, agreement.id);
  assert.deepEqual(view.members.map(x => x.user_id).sort(), [s.captain, s.member].sort());
  assert.equal(view.state, 'awaiting_funding');
});

test('two captains with overlapping consenting participants accept different tasks through one sorted participant lock order', async () => {
  const a = await f.user('Overlapping captain A'), b = await f.user('Overlapping captain B'), publisher = await f.user('Overlapping publisher');
  const applications = [];
  for (const [captain, member] of [[a, b], [b, a]]) {
    let team = await market.createTeam(captain, { name: 'Overlapping team', context: completeContext() }, key());
    await market.inviteMember(captain, team.id, { userId: member, expectedRevision: team.revision }, key());
    team = await market.acceptMembership(member, team.id, { expectedRevision: team.revision + 1 }, key());
    const task = await market.publishTask(publisher, { title: 'Parallel contract', category: 'Research', description: 'Synthetic', rewardCents: 100, milestones: [{ title: 'Report', amountCents: 100, deliverable: 'Report' }] }, key());
    const application = await market.apply(captain, task.id, { proposal: 'Consented overlap', teamId: team.id }, key());
    await market.consentApplication(member, application.id, {}, key());
    await market.inviteApplicant(publisher, application.id, {}, key());
    applications.push({ captain, id: application.id });
  }
  const database = (await f.owner.query('SELECT current_database() AS name')).rows[0].name;
  const blockers = await Promise.all([a, b].map(async user => {
    const client = new pg.Client({ connectionString: connectionString(f.config, 'migrator', database) });
    await client.connect(); await client.query('BEGIN');
    await client.query('SELECT user_id FROM campus.affiliations WHERE user_id=$1 FOR UPDATE', [user]);
    return client;
  }));
  let requests;
  try {
    requests = applications.map(x => settle(market.acceptInvitation(x.captain, x.id, {}, key())));
    let waited = false;
    for (let n = 0; n < 100; n++) {
      const row = (await f.owner.query("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND cardinality(pg_catalog.pg_blocking_pids(pid))>0")).rows[0];
      if (row.n >= 2) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waited, true, 'Both acceptance transactions must actually queue');
  } finally {
    await Promise.all(blockers.map(async c => { await c.query('COMMIT'); await c.end(); }));
  }
  const results = await Promise.all(requests);
  assert.deepEqual(results.filter(x => !x.ok).map(x => ({ code: x.error.code, message: x.error.message })), []);
  assert.equal(new Set(results.map(x => x.value.id)).size, 2);
  for (const r of results) assert.deepEqual((await market.agreement(a, r.value.id)).members.map(x => x.user_id).sort(), [a, b].sort());
});
