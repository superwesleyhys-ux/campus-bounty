import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const repo = resolve(process.env.CAMPUS_REVIEW_REPO || fileURLToPath(new URL('../../..',import.meta.url)));
const source = (p) => import(pathToFileURL(resolve(repo, p)));
const require = createRequire(resolve(repo, 'package.json'));
const { fixture } = await source('tests/backend/fixture.mjs');
const { createStore, member, account } = await source('backend/db/store.mjs');
const { createAuth } = await source('backend/modules/auth.mjs');
const { createMailWorker } = await source('backend/adapters/mail-worker.mjs');
const { unseal } = await source('backend/crypto.mjs');
const { SMTPServer } = require('smtp-server');
const nodemailer = require('nodemailer');

async function setup(t) {
  const f = await fixture();
  const store = createStore(f.urls);
  const auth = createAuth(store, f.config);
  t.after(async () => { await store.close(); await f.close(); });
  await store.verifyRoles();
  async function challenge(email = `${randomUUID()}@campus.example.test`, ip = randomUUID()) {
    const request = await auth.request({email}, ip);
    const { rows } = await f.owner.query('SELECT id,payload FROM campus.mail_jobs WHERE payload IS NOT NULL ORDER BY available_at DESC');
    const entry = rows.map(r => ({...r, data: unseal(f.config.encryptionKey,r.payload)})).find(r => r.data.challengeId === request.challengeId);
    return {challengeId:request.challengeId, code:entry?.data.code, displayName:'Independent reviewer', jobId:entry?.id};
  }
  const verifyInput = ({challengeId,code,displayName}) => ({challengeId,code,displayName});
  const verify = (c, ip = randomUUID()) => auth.verify(verifyInput(c), ip);
  const worker = (transport) => createMailWorker(store,{encryptionKey:f.config.encryptionKey, from:'review@campus.example.test',transport});
  return {f,store,auth,challenge,verify,worker};
}
const invalid = e => e.code === 'invalid_code';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };

test('independent: twelve concurrent correct replays mint exactly one session', async t => {
  const {f,challenge,verify} = await setup(t), c = await challenge();
  const results = await Promise.allSettled(Array.from({length:12},()=>verify(c)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>invalid(r.reason)));
  assert.deepEqual((await f.owner.query('SELECT count(*)::int AS users FROM campus.users')).rows[0],{users:1});
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.sessions')).rows[0].n,1);
  assert.equal((await f.owner.query('SELECT attempts FROM campus.challenges WHERE id=$1',[c.challengeId])).rows[0].attempts,1);
});

test('independent: distinct valid challenges for one email serialize identity creation', async t => {
  const {f,challenge,verify} = await setup(t), email='parallel@campus.example.test';
  const challenges=await Promise.all([challenge(email),challenge(email),challenge(email)]);
  const logins=await Promise.all(challenges.map(c=>verify(c)));
  assert.equal(new Set(logins.map(l=>l.user.id)).size,1);
  assert.equal(new Set(logins.map(l=>l.token)).size,3);
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.identities')).rows[0].n,1);
});

test('independent: concurrent wrong attempts never exceed five and permanently exhaust that challenge', async t => {
  const {f,challenge,verify}=await setup(t), c=await challenge();
  const wrong={...c,code:c.code==='000000'?'111111':'000000'};
  const results=await Promise.allSettled(Array.from({length:12},()=>verify(wrong)));
  assert.ok(results.every(r=>r.status==='rejected' && invalid(r.reason)));
  assert.equal((await f.owner.query('SELECT attempts FROM campus.challenges WHERE id=$1',[c.challengeId])).rows[0].attempts,5);
  await assert.rejects(verify(c),invalid);
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.sessions')).rows[0].n,0);
});

test('independent: concurrent email and ingress request limits persist; unknown domains create no identity/mail', async t => {
  const {f,auth}=await setup(t);
  let results=await Promise.allSettled(Array.from({length:8},()=>auth.request({email:'limited@campus.example.test'},randomUUID())));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='rate_limited'));
  results=await Promise.allSettled(Array.from({length:23},(_,n)=>auth.request({email:`unknown-${n}@unreviewed.edu`},'same-ingress')));
  // Domain refusal is now explicit; rejected requests must still consume the
  // same ingress quota and must not create challenges or mail.
  assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='unsupported_university_email').length,20);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='rate_limited').length,3);
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.challenges')).rows[0].n,3);
  assert.equal((await f.owner.query('SELECT count(*)::int AS n FROM campus.mail_jobs')).rows[0].n,3);
  for(let n=0;n<40;n++) await assert.rejects(auth.verify({challengeId:randomUUID(),code:'123456',displayName:'Unknown'},'verify-ingress'),invalid);
  await assert.rejects(auth.verify({challengeId:randomUUID(),code:'123456',displayName:'Unknown'},'verify-ingress'),e=>e.code==='rate_limited');
});

test('independent: expiry permits account history, locks invalidate session, and revoked/expired challenges fail', async t => {
  const {f,store,auth,challenge,verify}=await setup(t), email='lifecycle@campus.example.test';
  const c=await challenge(email), login=await verify(c), id=login.user.id;
  await f.owner.query("UPDATE campus.affiliations SET valid_until=now()-interval '1 second' WHERE user_id=$1",[id]);
  assert.equal((await auth.resolve(login.token)).id,id);
  const me=await store.as(id,c=>account(c,id));
  assert.equal(me.campus_verified,false); assert.equal(me.can_apply,false);
  await assert.rejects(store.as(id,c=>member(c,id)),e=>e.code==='membership_required');
  const renewed=await challenge(email); await verify(renewed);
  assert.equal((await store.as(id,c=>account(c,id))).campus_verified,true);
  assert.equal((await store.as(id,c=>account(c,id))).can_apply,false);
  await f.owner.query("UPDATE campus.users SET account_status='locked' WHERE id=$1",[id]);
  await assert.rejects(auth.resolve(login.token),e=>e.code==='unauthenticated');
  await assert.rejects(store.as(id,c=>account(c,id)),e=>e.code==='account_locked');
  await assert.rejects(verify(await challenge(email)),invalid);
  const expired=await challenge();
  await f.owner.query("UPDATE campus.challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.challengeId]);
  await assert.rejects(verify(expired),invalid);
  const disabled=await challenge(); await f.owner.query('UPDATE campus.domains SET enabled=false');
  await assert.rejects(verify(disabled),invalid);
  await auth.logout(login.token);
  await f.owner.query("UPDATE campus.users SET account_status='active' WHERE id=$1",[id]);
  await assert.rejects(auth.resolve(login.token),e=>e.code==='unauthenticated');
});

test('independent: two active SMTP workers do not double-lease a fresh job; real local SMTP only', async t => {
  const {f,challenge,verify,worker}=await setup(t), c=await challenge(), messages=[];
  const sink=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,session,cb){let content='';stream.on('data',b=>content+=b);stream.on('end',()=>{messages.push(content);cb()});}});
  await new Promise(r=>sink.listen(0,'127.0.0.1',r));
  const transport=nodemailer.createTransport({host:'127.0.0.1',port:sink.server.address().port,ignoreTLS:true});
  t.after(async()=>{transport.close(); await new Promise(r=>sink.close(r));});
  const results=await Promise.all([worker(transport).tick(),worker(transport).tick()]);
  assert.deepEqual(results.sort(),[false,true]); assert.equal(messages.length,1);
  assert.ok(messages[0].includes(c.code));
  assert.equal((await f.owner.query('SELECT attempts,status,payload FROM campus.mail_jobs WHERE id=$1',[c.jobId])).rows[0].attempts,1);
  await verify(c);
});

for(const staleOutcome of ['success','failure']) test(`independent: expired old lease ${staleOutcome} cannot overwrite replacement worker`,async t=>{
  const {f,challenge,worker}=await setup(t), c=await challenge();
  const entered=deferred(), finish=deferred(), delivered=[];
  const old=worker({async sendMail(m){delivered.push(m);entered.resolve(); await finish.promise; if(staleOutcome==='failure')throw Error('simulated unknown result');return {accepted:[m.to],rejected:[]};}});
  const oldTick=old.tick(); await entered.promise;
  await f.owner.query("UPDATE campus.mail_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[c.jobId]);
  await worker({async sendMail(m){delivered.push(m);return {accepted:[m.to],rejected:[]};}}).tick();
  finish.resolve(); await oldTick;
  const row=(await f.owner.query('SELECT status,attempts,payload,lease_id,last_error FROM campus.mail_jobs WHERE id=$1',[c.jobId])).rows[0];
  assert.deepEqual(row,{status:'sent',attempts:2,payload:null,lease_id:null,last_error:null});
  assert.equal(delivered[0].messageId,delivered[1].messageId); assert.equal(delivered[0].text,delivered[1].text);
});

test('independent: unknown SMTP delivery result retries same message/code, OTP remains exactly once',async t=>{
  const {f,challenge,verify,worker}=await setup(t), c=await challenge(), delivered=[];
  const w=worker({async sendMail(m){delivered.push(m);if(delivered.length===1)throw Error('delivery outcome unknown');return {accepted:[m.to],rejected:[]};}});
  await w.tick();
  assert.equal((await f.owner.query('SELECT status FROM campus.mail_jobs WHERE id=$1',[c.jobId])).rows[0].status,'pending');
  await f.owner.query('UPDATE campus.mail_jobs SET available_at=now() WHERE id=$1',[c.jobId]);
  await w.tick(); assert.equal(delivered.length,2);
  assert.equal(delivered[0].messageId,delivered[1].messageId); assert.equal(delivered[0].text,delivered[1].text);
  await verify(c); await assert.rejects(verify(c),invalid);
});

test('independent: expired mail and exhausted crashed lease never send',async t=>{
  const {f,challenge,worker}=await setup(t), expired=await challenge(), exhausted=await challenge();
  await f.owner.query("UPDATE campus.mail_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.jobId]);
  await f.owner.query("UPDATE campus.mail_jobs SET status='sending', attempts=5,lease_id=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=$1",[exhausted.jobId]);
  let sends=0; assert.equal(await worker({async sendMail(){sends++;}}).tick(),false); assert.equal(sends,0);
  const rows=(await f.owner.query('SELECT status,payload,last_error FROM campus.mail_jobs ORDER BY last_error')).rows;
  assert.deepEqual(rows,[{status:'dead',payload:null,last_error:'expired'},{status:'dead',payload:null,last_error:'retry_exhausted'}]);
});
