import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {paymentCommandSchemas} from '../../backend/payments/command-models.mjs';
test('fix1 generated payment response status and every local reference resolve',async()=>{
 const spec=JSON.parse(await readFile(new URL('../../docs/backend-openapi.json',import.meta.url),'utf8'));
 const refs=[];
 function walk(v){if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(k==='$ref'&&x.startsWith('#/'))refs.push(x);else walk(x);}}
 walk(spec);
 for(const ref of refs){let value=spec;for(const part of ref.slice(2).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~')))value=value?.[part];assert.notEqual(value,undefined,ref);}
 const path=spec.paths['/api/v1/funding-obligations/{id}/payment-attempts']??spec.paths['/funding-obligations/{id}/payment-attempts'];
 assert.ok(path.post.responses['202'].content['application/json'].schema.$ref);assert.equal(path.post.responses['200'],undefined);
 for(const name of Object.keys(paymentCommandSchemas).filter(n=>n!=='money_cancel_order'))assert.ok(spec.components.schemas['PaymentCommand_'+name]);
 assert.equal(paymentCommandSchemas.money_onboarding.safeParse({receipt:{operationId:'bad',status:'queued'},current:{}}).success,false);
});
