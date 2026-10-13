import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo=process.env.CAMPUS_REVIEW_REPO ? pathToFileURL(resolve(process.env.CAMPUS_REVIEW_REPO)+'/') : new URL('../../../',import.meta.url);
const {taskSchema,taskModule}=await import(new URL('backend/modules/tasks.mjs',repo));

// This suite exercises only real schema and pre-transaction guards. No PostgreSQL
// behavior is simulated, and a sentinel rejects any attempt to enter a transaction.
const sentinel=new Error('STOP_AT_DATABASE_BOUNDARY');let boundaryCalls=0;
const task=taskModule({as(){boundaryCalls++;throw sentinel;}});
const uuid='c25b3486-c6a9-49af-a853-3c852c84d7db';
const body={title:'Independent pure input check',category:'Research',description:'No database',rewardCents:100,milestones:[{title:'One',amountCents:40,deliverable:'Data'},{title:'Two',amountCents:60,deliverable:'Report'}]};
const invalid=p=>assert.rejects(p,e=>e.code==='invalid_input'&&e.status===422);
console.log(JSON.stringify({scope:'Pure schema and pre-transaction guard checks only; PostgreSQL NOT_RUN',node:process.version,reviewSourceCandidate:'5ef1b68b55352786de7ef19895833c9f70936824'}));

test('real taskSchema rejects fractional/zero/negative/overflow amounts, unknown fields, and invalid milestone counts',()=>{
 for(const amount of [0,-1,0.5,100000001,Number.MAX_SAFE_INTEGER,Infinity,NaN,'100']){
  assert.equal(taskSchema.safeParse({...body,rewardCents:amount}).success,false);
  assert.equal(taskSchema.safeParse({...body,milestones:[{...body.milestones[0],amountCents:amount}]}).success,false);
 }
 for(const list of [[],Array(21).fill(body.milestones[0])])assert.equal(taskSchema.safeParse({...body,milestones:list}).success,false);
 assert.equal(taskSchema.safeParse({...body,ownerId:uuid}).success,false);
 assert.equal(taskSchema.safeParse({...body,milestones:[{...body.milestones[0],status:'accepted'}]}).success,false);
});
test('publishTask rejects unequal totals before entering the database; matching maximum total passes pre-transaction guards',async()=>{
 const before=boundaryCalls;
 await assert.rejects(task.publishTask(uuid,{...body,rewardCents:101},'input-key'),e=>e.code==='invalid_milestone_budget'&&e.status===422);
 assert.equal(boundaryCalls,before);
 const maximum={...body,rewardCents:100000000,milestones:Array.from({length:20},()=>({...body.milestones[0],amountCents:5000000}))};
 assert.equal(taskSchema.safeParse(maximum).success,true);
 await assert.rejects(task.publishTask(uuid,maximum,'input-key'),e=>e===sentinel);
 assert.equal(boundaryCalls,before+1);
});
test('submitMilestone rejects invalid expectedVersion/content/identity fields before transaction boundary',async()=>{
 const before=boundaryCalls;
 for(const version of [-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'0',null])await invalid(task.submitMilestone(uuid,uuid,{content:'Data',expectedRevision:1,expectedVersion:version},'input-key'));
 await invalid(task.submitMilestone(uuid,uuid,{content:'',expectedRevision:1,expectedVersion:0},'input-key'));
 await invalid(task.submitMilestone(uuid,uuid,{content:'Data',expectedRevision:1,expectedVersion:0,authorId:uuid},'input-key'));
 assert.equal(boundaryCalls,before);
 await assert.rejects(task.submitMilestone(uuid,uuid,{content:'Data',expectedRevision:1,expectedVersion:0},'input-key'),e=>e===sentinel);
});
test('acceptMilestone rejects zero, negative, fractional or unsafe versions and forged state fields',async()=>{
 const before=boundaryCalls;
 for(const version of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1,'1',null])await invalid(task.acceptMilestone(uuid,uuid,{submissionId:uuid,expectedRevision:1,expectedVersion:version},'input-key'));
 await invalid(task.acceptMilestone(uuid,uuid,{submissionId:uuid,expectedRevision:1,expectedVersion:1,state:'accepted'},'input-key'));
 assert.equal(boundaryCalls,before);
 await assert.rejects(task.acceptMilestone(uuid,uuid,{submissionId:uuid,expectedRevision:1,expectedVersion:1},'input-key'),e=>e===sentinel);
});
