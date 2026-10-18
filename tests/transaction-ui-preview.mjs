import Stripe from 'stripe';
import {spawn} from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {SMTPServer} from 'smtp-server';
import nodemailer from 'nodemailer';
import {isolated,journal,key} from './backend/transaction-ui-fixture.mjs';
import {configure} from './backend/transaction-ui-setup.mjs';
import {createMailWorker} from '../backend/adapters/mail-worker.mjs';
const folder=new URL('../.data/backend/transaction-ui/',import.meta.url),evidence=new URL('../.superpowers/sdd/transaction-integration-plan/task-2c-evidence/',import.meta.url);
for(const port of [3024,3034,2527]){const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));}
const f=await isolated(1);await f.migrateThrough(22);const x=await configure(f);
await mkdir(folder,{recursive:true,mode:0o700});
const reviewer=await f.user('Synthetic eligibility reviewer');
await f.owner.query('INSERT INTO campus.eligibility_reviewers SELECT $1,id FROM campus.institutions',[reviewer]);
const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,session,callback){let text='';stream.on('data',d=>text+=d);stream.on('end',async()=>{const address=session.envelope.rcptTo[0]?.address;if(!/^[a-z0-9-]+@transaction\.example\.test$/.test(address??''))return callback(Error('Synthetic recipient only'));await writeFile(new URL(address.split('@')[0]+'.eml',folder),text,{mode:0o600});callback();});}});
await new Promise(r=>smtp.listen(2527,'127.0.0.1',r));await journal({action:'listening',port:2527,pid:process.pid});
const transport=nodemailer.createTransport({host:'127.0.0.1',port:2527,secure:false,ignoreTLS:true});
const mail=createMailWorker(f.store,{encryptionKey:f.config.encryptionKey,transport,from:'Campus Bounty <noreply@transaction.example.test>'});
const create=x.transport.client.checkout.sessions.create;x.transport.client.checkout.sessions.create=async(...args)=>{const s=await create(...args);s.url='https://checkout.stripe.com/c/pay/'+s.id;return s;};
const provider=http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://127.0.0.1:3034');
 if(u.pathname.startsWith('/pay/')){const id=u.pathname.slice(5);const s=x.transport.sessions.get(id);if(!s){res.writeHead(404);return res.end('Unknown synthetic session');}res.setHeader('Content-Type','text/html');return res.end(`<h1>Synthetic local payment test</h1><p>This is not Stripe acceptance. No real funds.</p><p>Amount: ${(s.amount_total/100).toFixed(2)} USD</p><p>Synthetic processing fee: ${u.searchParams.get('fee')==='300'?'3.00':'1.00'} USD</p><form method="POST" action="http://127.0.0.1:3034/complete/${id}?fee=${u.searchParams.get('fee')==='300'?'300':'100'}"><button>Simulate payment success</button></form>`);}
 if(req.method==='POST'&&u.pathname.startsWith('/complete/')){const id=u.pathname.slice(10);x.transport.pay(id,{fee:u.searchParams.get('fee')==='300'?300:100,available:true});const payload=JSON.stringify({id:'evt_'+key(),type:'checkout.session.completed',livemode:false,data:{object:{id}}});const signature=new Stripe('sk_test_synthetic_local_not_a_credential').webhooks.generateTestHeaderString({payload,secret:'whsec_synthetic_local_not_a_credential'});const response=await fetch('http://127.0.0.1:3024/api/v1/webhooks/stripe',{method:'POST',headers:{'stripe-signature':signature},body:payload});if(response.status!==200)throw Error('Local signed event rejected: '+response.status);await x.worker.inbox();await x.worker.tick();await appendFile(new URL('synthetic-webhook-receipts.jsonl',evidence),JSON.stringify({at:new Date().toISOString(),sessionId:id,status:response.status,synthetic:true})+'\n');res.writeHead(303,{Location:'http://127.0.0.1:3024/?view=workspace&tab=agreements'});return res.end();}
 if(u.pathname==='/onboard'){res.setHeader('Content-Type','text/html');return res.end('<h1>Synthetic local onboarding test</h1><p>No real legal identity or bank information is collected.</p><a href="http://127.0.0.1:3024/?view=account">Return to account and refresh provider status</a>');}
 if(req.method==='POST'&&u.pathname==='/review'){let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);if(body.userId===reviewer)throw Error('self review');const request=await f.market.requestEligibility(body.userId,{enrollmentSummary:'Synthetic local student eligibility evidence',attestation:true},key());await f.market.decideEligibility(reviewer,request.id,{decision:'approved',reason:'Synthetic local test scenario only',validUntil:new Date(Date.now()+86400000*30).toISOString()},key());res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({approved:true}));}
 if(u.pathname==='/receipts'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(x.transport.calls.map(c=>({kind:c.kind,key:c.key,amountCents:c.p?.line_items?.[0]?.price_data?.unit_amount}))));}
 res.writeHead(404);res.end();
 }catch(e){res.writeHead(500);res.end('Synthetic operation failed');await appendFile(new URL('preview-errors.log',evidence),String(e.stack)+'\n');}});
await new Promise(r=>provider.listen(3034,'127.0.0.1',r));await journal({action:'listening',port:3034,pid:process.pid});
let busy=false;const timer=setInterval(async()=>{if(busy)return;busy=true;try{await mail.tick();await x.worker.tick();}catch(e){await appendFile(new URL('preview-errors.log',evidence),String(e.stack)+'\n');}finally{busy=false;}},350);
const env={...process.env,NODE_ENV:'development',CAMPUS_BACKEND:'postgres',CAMPUS_DEMO:'0',CAMPUS_BUILD_DIR:'.next-backend-transaction-ui',CAMPUS_ORIGIN:'http://127.0.0.1:3024',CAMPUS_DB_APP:f.urls.app,CAMPUS_DB_AUTH:f.urls.auth,CAMPUS_DB_WORKER:f.urls.worker,CAMPUS_OTP_KEY:f.config.otpKey,CAMPUS_MAIL_KEY:f.config.encryptionKey,CAMPUS_SMTP_HOST:'127.0.0.1',CAMPUS_SMTP_PORT:'2527',CAMPUS_MAIL_FROM:'Campus Bounty <noreply@transaction.example.test>',CAMPUS_PAYMENTS_ENABLED:'1',CAMPUS_PAYMENT_ENVIRONMENT_ID:x.env.id,CAMPUS_STRIPE_PLATFORM_ACCOUNT_ID:x.env.platformAccountId,CAMPUS_PAYMENT_MODE:'sandbox',CAMPUS_STRIPE_KEY:'sk_test_synthetic_local_not_a_credential',CAMPUS_STRIPE_WEBHOOK_SECRET:'whsec_synthetic_local_not_a_credential'};
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3024'],{env,stdio:'inherit'});await journal({action:'spawned',pid:child.pid,parent:process.pid,port:3024});
await writeFile(new URL('release.json',folder),JSON.stringify({database:f.database,origin:env.CAMPUS_ORIGIN,pid:process.pid,nextPid:child.pid,environmentId:x.env.id,synthetic:true}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;clearInterval(timer);child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));while(busy)await new Promise(r=>setTimeout(r,50));transport.close();await Promise.all([new Promise(r=>smtp.close(r)),new Promise(r=>provider.close(r))]);await f.close();await journal({action:'preview_stopped',pid:process.pid});process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
console.log('Task2C isolated synthetic app 3024, provider 3034, local mail 2527. No external provider or mail calls.');
