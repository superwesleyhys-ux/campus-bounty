// Read-only and rejected-command HTTP checks against the local synthetic QA session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { request } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const origin='http://127.0.0.1:3020';
  const output=path.resolve('docs/evidence/interaction-round7/http-probe.json');
  assert.ok(!fs.existsSync(output),'Preserve earlier evidence');
  const client=await request.newContext({baseURL:origin,storageState:'.data/qa/round7/persona.state.json'});
  const guest=await request.newContext({baseURL:origin});
  const checks=[];
  try {
    const first=await client.get('/api/v1/notifications?limit=2&unread=true');assert.equal(first.status(),200);assert.equal(first.headers()['cache-control'],'no-store');
    const data=await first.json();assert.ok(data.items.length>0);assert.ok(data.items.every(n=>n.readAt===null));assert.equal(data.limit,2);
    const again=await client.get('/api/v1/notifications?limit=2&unread=true');assert.deepEqual(await again.json(),data);checks.push('Authenticated notification GET is no-store and does not mark any record read');
    for (const q of ['limit=2&limit=3','unknown=x','unread=1','cursor=bad','limit=0','limit=51']) {
      const r=await client.get('/api/v1/notifications?'+q);assert.equal(r.status(),422);assert.equal((await r.json()).code,'invalid_input');
    }
    checks.push('Real route rejects duplicate, unknown, invalid boolean/cursor and out-of-range queries');
    const headers={Origin:origin,'Idempotency-Key':randomUUID()};
    const invalid=await client.post('/api/v1/notifications/not-a-uuid/read',{data:{},headers});assert.equal(invalid.status(),422);
    const missing=await client.post('/api/v1/notifications/'+randomUUID()+'/read',{data:{},headers});assert.equal(missing.status(),404);
    const fields=await client.post('/api/v1/notifications/'+data.items[0].id+'/read',{data:{recipientId:randomUUID()},headers});assert.equal(fields.status(),422);
    const csrf=await client.post('/api/v1/notifications/'+data.items[0].id+'/read',{data:{},headers:{...headers,Origin:'http://invalid.test'}});assert.equal(csrf.status(),403);
    checks.push('Rejected read acknowledgements enforce UUID, existence, strict body and origin without changing inbox');
    assert.equal((await guest.get('/api/v1/notifications')).status(),401);checks.push('Unauthenticated inbox read is denied');
    const last=await client.get('/api/v1/notifications?limit=2&unread=true');assert.deepEqual(await last.json(),data);
    fs.writeFileSync(output,JSON.stringify({passed:true,checks,scope:'Local synthetic persona session; only GET and rejected commands. No successful acknowledgement, data change, private response content or credentials saved.'},null,2)+'\n',{flag:'wx'});
    console.log('4 HTTP boundary checks passed; synthetic inbox unchanged.');
  } finally { await client.dispose();await guest.dispose(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
