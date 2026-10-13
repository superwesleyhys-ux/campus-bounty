// Real 001..009 -> frozen 010 + reviewed 011/012/013 forward migration in a disposable DB, not a trigger-disabled simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID as key } from 'node:crypto';
import { localConfig, connectionString } from '../../../scripts/backend-local.mjs';
import reviewedUpgrade from '../../conversation-reviewed-upgrade.cjs';
import path from 'node:path';
import { createStore } from '../../../backend/db/store.mjs';
import { createMarket } from '../../../backend/modules/market.mjs';

test('actual 009-to-013 upgrade preserves signed data and legacy states without invented reviews; publisher explicitly completes all-accepted legacy work', async () => {
  const config = localConfig(), database = 'campus_test_' + key().replaceAll('-', '');
  assert.equal(new URL(connectionString(config, 'migrator')).hostname, '127.0.0.1');
  assert.match(database, /^campus_test_[a-f0-9]{32}$/);
  const admin = new pg.Client({ connectionString: connectionString(config, 'migrator') });
  let owner, store, created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    owner = new pg.Client({ connectionString: connectionString(config, 'migrator', database) });
    await owner.connect();
    await owner.query('CREATE SCHEMA campus; CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = new URL('../../../backend/db/migrations/', import.meta.url);
    const names = (await readdir(dir)).filter(x => /^00[1-9]_.*\.sql$/.test(x)).sort();
    assert.equal(names.length, 9);
    for (const name of names) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      await owner.query('BEGIN');
      try {
        await owner.query(sql);
        await owner.query('INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
        await owner.query('COMMIT');
      } catch (e) { await owner.query('ROLLBACK'); throw e; }
    }
    const institution = key(), publisher = key(), participant = key(), outsider = key();
    await owner.query("INSERT INTO campus.institutions VALUES($1,'Upgrade fixture campus',true,'Synthetic local fixture')", [institution]);
    await owner.query("INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('upgrade.example.test',$1,true)", [institution]);
    for (const id of [publisher, participant, outsider]) {
      await owner.query("INSERT INTO campus.users(id,display_name) VALUES($1,'Upgrade participant')", [id]);
      await owner.query("INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'upgrade.example.test',now()+interval '1 year',true)", [id, institution]);
    }
    const seed = async (state, milestoneStates) => {
      const task = key(), application = key(), agreement = key();
      const terms = { members: [participant], historicalSentinel: key(), milestones: milestoneStates.map((_, i) => ({ position: i + 1, title: `Legacy ${i + 1}`, amount_cents: 100, deliverable: 'Legacy source summary' })) };
      await owner.query("INSERT INTO campus.tasks(id,owner_id,title,category,status,reward_cents) VALUES($1,$2,'Legacy task','Research','contracted',$3)", [task, publisher, milestoneStates.length * 100]);
      await owner.query("INSERT INTO campus.applications(id,task_id,applicant_id,proposal,state) VALUES($1,$2,$3,'Historical proposal','accepted')", [application, task, participant]);
      await owner.query('INSERT INTO campus.application_members(application_id,user_id,confirmed) VALUES($1,$2,true)', [application, participant]);
      await owner.query('INSERT INTO campus.agreements(id,task_id,application_id,owner_id,captain_id,state,terms) VALUES($1,$2,$3,$4,$5,$6,$7)', [agreement, task, application, publisher, participant, state, terms]);
      await owner.query('INSERT INTO campus.agreement_members(agreement_id,user_id) VALUES($1,$2)', [agreement, participant]);
      const milestones = [];
      for (const [i, ms] of milestoneStates.entries()) {
        const id = key();
        await owner.query("INSERT INTO campus.milestones(id,agreement_id,position,title,amount_cents,deliverable,state,version) VALUES($1,$2,$3,$4,100,'Legacy source summary',$5,$6)", [id, agreement, i + 1, `Legacy ${i + 1}`, ms, ms === 'pending' ? 0 : 1]);
        let submission = null;
        if (ms !== 'pending') {
          submission = key();
          await owner.query("INSERT INTO campus.submissions(id,milestone_id,author_id,version,content) VALUES($1,$2,$3,1,'Historical text')", [submission, id, participant]);
        }
        milestones.push({ id, state: ms, submission });
      }
      return { id: agreement, terms, state, milestones };
    };
    const done = await seed('active', ['accepted', 'accepted']);
    const partial = await seed('active', ['accepted', 'submitted']);
    const unfunded = await seed('awaiting_funding', ['pending']);
    const before = (await owner.query('SELECT id,state,terms,created_at FROM campus.agreements ORDER BY id')).rows;
    const submissionsBefore = (await owner.query('SELECT * FROM campus.submissions ORDER BY id')).rows;
    // Keep this independent test's exact historical 009→013 endpoint.
    // 010/011 use explicit frozen bytes; 012/013 use pre-commit preservation.
    let applied = 0;
    for (const row of reviewedUpgrade.prior011.slice(9)) {
      const sql = await readFile(new URL(row.name, dir), 'utf8');
      assert.equal(createHash('sha256').update(sql).digest('hex'), row.checksum);
      await owner.query('BEGIN');
      try {
        await owner.query(sql);
        await owner.query('INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)', [row.name,row.checksum]);
        await owner.query('COMMIT'); applied++;
      } catch (e) { await owner.query('ROLLBACK'); throw e; }
    }
    for (const target of ['012','013']) {
      const result = await reviewedUpgrade[`upgradeReviewed${target}`](owner, {
        migration: reviewedUpgrade[`migration${target}Name`],
        expectedHash: reviewedUpgrade[`migration${target}Sha`],
        evidenceDirectory: path.resolve('.superpowers/sdd/interaction-round10-plan/task-2-evidence/legacy-fulfillment',key(),target),
      });
      applied += result.applied;
    }
    assert.equal(applied, 4, 'Expected exactly frozen 010 and reviewed 011/012/013 to be newly applied');
    const additions = (await owner.query("SELECT name,checksum FROM campus.schema_migrations WHERE name > '009_team_context.sql' ORDER BY name")).rows;
    assert.deepEqual(additions.map(x=>x.name), ['010_milestone_revision_workflow.sql','011_notifications_and_overview.sql','012_conversation_history_context.sql','013_message_scope_revalidation.sql']);
    assert.equal(additions[0].checksum, '14266b68faaae8db3104872ceaffd78f8cfb92b45b6e3a1a3b550af250ad27f1', 'Round6 frozen 010 must remain byte-identical');
    assert.equal(additions[1].checksum, createHash('sha256').update(await readFile(new URL(additions[1].name, dir))).digest('hex'));
    assert.equal(additions[1].checksum, '3a08d04d84ba90fb636b574591e3720c92fa60aba13bee99ac976a0a79075011', 'Round7 frozen 011 remains byte-identical');
    assert.equal(additions[2].checksum, '05ce34dd5067ae44bf6e1f15cc995f8184ddbe6e352228c554fb919bdf837d26', 'Round8 reviewed 012 exact candidate');
    assert.equal(additions[3].checksum, 'ed5d08606e7dd93d588cba87993dbd5f7f9c556649da7f9e60b39d1414405190', 'Round8 reviewed 013 exact candidate');
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM campus.notifications')).rows[0].n, 0, 'No historical notification backfill');
    assert.deepEqual((await owner.query('SELECT id,state,terms,created_at FROM campus.agreements ORDER BY id')).rows, before);
    assert.deepEqual((await owner.query('SELECT * FROM campus.submissions ORDER BY id')).rows, submissionsBefore);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM campus.milestone_reviews')).rows[0].n, 0);
    for (const a of [done, partial, unfunded]) {
      for (const prior of a.milestones) {
        const row = (await owner.query('SELECT * FROM campus.milestones WHERE id=$1', [prior.id])).rows[0];
        assert.equal(row.state, prior.state); assert.equal(row.revision, 1);
        assert.equal(row.latest_submission_id, prior.submission);
        assert.equal(row.accepted_submission_id, prior.state === 'accepted' ? prior.submission : null);
      }
    }
    store = createStore(Object.fromEntries(['app', 'auth', 'worker'].map(role => [role, connectionString(config, role, database)])));
    const market = createMarket(store);
    await assert.rejects(market.completeAgreement(participant, done.id, {}, key()), { code: 'not_owner' });
    await assert.rejects(market.completeAgreement(outsider, done.id, {}, key()), { code: 'not_found' });
    await assert.rejects(market.completeAgreement(publisher, partial.id, {}, key()), { code: 'invalid_state' });
    await assert.rejects(market.completeAgreement(publisher, unfunded.id, {}, key()), { code: 'funding_required' });
    const requestKey = key();
    const completed = await market.completeAgreement(publisher, done.id, {}, requestKey);
    assert.equal(completed.agreement.state, 'completed');
    assert.equal(completed.receipt.operation, 'completed');
    assert.equal(completed.receipt.agreementId, done.id);
    assert.deepEqual(await market.completeAgreement(publisher, done.id, {}, requestKey), completed);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM campus.audit WHERE action='agreement.completed' AND object_id=$1", [done.id])).rows[0].n, 1);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM campus.milestone_reviews')).rows[0].n, 0);
    assert.deepEqual((await market.agreement(participant, done.id)).terms, done.terms);
    assert.deepEqual((await owner.query('SELECT recipient_id,kind,target_id FROM campus.notifications')).rows, [{recipient_id:participant,kind:'agreement.completed',target_id:done.id}], 'Only the explicit post-upgrade completion creates one notice for its other participant');
    assert.equal(await reviewedUpgrade.verifyReviewedReplay013(owner, { migration: reviewedUpgrade.migration013Name, expectedHash: reviewedUpgrade.migration013Sha }), 0, 'Repeated migration must be a no-op');
  } finally {
    await store?.close();
    await owner?.end();
    if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
