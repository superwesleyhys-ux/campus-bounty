// Diagnostic historical-vs-candidate proof, not an acceptance test. Fresh disposable database only.
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID as key,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {localConfig,connectionString} from '../../../scripts/backend-local.mjs';
import {createStore} from '../../../backend/db/store.mjs';
import {createMarket} from '../../../backend/modules/market.mjs';
const config=localConfig(),db='campus_test_'+key().replaceAll('-','');
assert.match(db,/^campus_test_[a-f0-9]{32}$/);assert.equal(new URL(connectionString(config,'migrator',db)).hostname,'127.0.0.1');
const admin=new pg.Client({connectionString:connectionString(config,'migrator')});let owner,store,created=false;
await admin.connect();
try {
 await admin.query(`CREATE DATABASE ${db}`);created=true;owner=new pg.Client({connectionString:connectionString(config,'migrator',db)});await owner.connect();
 await owner.query('CREATE SCHEMA campus;CREATE TABLE campus.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())');
 const dir=new URL('../../../backend/db/migrations/',import.meta.url);
 const names=(await readdir(dir)).filter(n=>/^0(?:0[1-9]|1[01])_.*\.sql$/.test(n)).sort();assert.equal(names.length,11);
 for(const name of names){const sql=await readFile(new URL(name,dir),'utf8');await owner.query(sql);await owner.query('INSERT INTO campus.schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
 const inst=key();await owner.query("INSERT INTO campus.institutions VALUES($1,'Synthetic local baseline',true,'Independent')",[inst]);await owner.query("INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('baseline.example.test',$1,true)",[inst]);
 const user=async()=>{const id=key();await owner.query("INSERT INTO campus.users(id,display_name) VALUES($1,'Synthetic baseline')",[id]);await owner.query("INSERT INTO campus.affiliations(user_id,institution_id,domain,valid_until,can_apply) VALUES($1,$2,'baseline.example.test',now()+interval '1 day',true)",[id,inst]);return id;};
 const publisher=await user(),worker=await user();
 store=createStore(Object.fromEntries(['app','auth','worker'].map(role=>[role,connectionString(config,role,db)])));const market=createMarket(store);
 const task=await market.publishTask(publisher,{title:'Baseline scope',category:'Research',description:'Synthetic',rewardCents:100,milestones:[{title:'Stage',deliverable:'Synthetic',amountCents:100}]},key());
 const app=await market.apply(worker,task.id,{proposal:'Synthetic'},key());await market.inviteApplicant(publisher,app.id,{},key());const agreement=await market.acceptInvitation(worker,app.id,{},key());
 const product=await market.publishProduct(publisher,{title:'Baseline product',description:'Synthetic',priceCents:100,stock:1,deliveryMethods:['pickup'],shippingCents:0},key());const quote=await market.quote(worker,product.id,{quantity:1,deliveryMethod:'pickup'},key());const order=await market.order(worker,{quoteId:quote.id},key());
 const results=[];
 for(const stage of ['011','012-original-candidate']) {
  if(stage!=='011') {const sql=await readFile(new URL('../../../docs/evidence/interaction-round8/independent/012-initial-candidate.sql',import.meta.url),'utf8');assert.equal(createHash('sha256').update(sql).digest('hex'),'fcb8d2b1562d971feb23162ea30b226e46ca3f6384561d50eb228dbb2f165a76');await owner.query(sql);}
  for(const state of ['restricted','expired']) {
   await owner.query('UPDATE campus.users SET account_status=$2 WHERE id=$1',[worker,state==='restricted'?'restricted':'active']);await owner.query("UPDATE campus.affiliations SET valid_until=now()+($2::int*interval '1 day') WHERE user_id=$1",[worker,state==='expired'?-1:1]);
   for(const [scope,id,column] of [['agreement',agreement.id,'agreement_id'],['order',order.id,'order_id']]) {
    const before=Number((await owner.query('SELECT count(*) AS n FROM campus.notifications')).rows[0].n);
    let result;try {result=await store.as(worker,c=>c.query(`INSERT INTO campus.messages(sender_id,${column},body) VALUES($1,$2,'Synthetic restricted or expired proof') RETURNING id`,[worker,id]));}catch(e){result={error:e.code};}
    const after=Number((await owner.query('SELECT count(*) AS n FROM campus.notifications')).rows[0].n);
    results.push({migration:stage,scope,state,messageCommitted:result.rowCount===1,notificationDelta:after-before,errorCode:result.error??null});
   }
  }
 }
 console.log(JSON.stringify({purpose:'Historical provenance; true messageCommitted documents a bypass, not a passed guard',results},null,2));
 assert.equal(results.length,8);assert.ok(results.every(x=>x.messageCommitted&&x.notificationDelta===1),'Expected diagnostic historical baseline to reproduce for all eight cases');
} finally {await store?.close();await owner?.end();if(created)await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);await admin.end();}
