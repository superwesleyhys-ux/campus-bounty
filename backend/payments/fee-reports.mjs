import {createHash} from 'node:crypto';
export const FEE_REPORT_TYPE='all_fees.balance_transaction_created.itemized.2';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function decimalCents(value){
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))throw Error('fee_report_amount_invalid');
 const [whole,fraction='']=value.split('.'),n=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(n>100000000n)throw Error('fee_report_amount_invalid');return Number(n);
}
// Bounded RFC4180 parsing. A row's identity excludes description and the report
// run/window, so an overlapping export cannot become another cash effect.
export function parseFeeCsv(text,platformAccountId){
 if(Buffer.byteLength(text)>8*1024*1024)throw Error('fee_report_too_large');
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}
  else if(c==='"'){if(field)throw Error('fee_report_csv_invalid');quoted=true;}
  else if(c===','){row.push(field);field='';}
  else if(c==='\n'){row.push(field.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);row=[];field='';}
  else field+=c;
  if(rows.length>10000||field.length>16384)throw Error('fee_report_too_large');
 }
 if(quoted)throw Error('fee_report_csv_invalid');if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
 const headers=rows.shift()??[];if(new Set(headers).size!==headers.length)throw Error('fee_report_csv_invalid');
 const required=['balance_transaction_id','fee_transaction_id','incurred_by','incurred_by_type','amount','tax','currency','product','feature_name','settled_via'];if(required.some(k=>!headers.includes(k)))throw Error('fee_report_columns_missing');
 const seen=new Set();return rows.map(values=>{
  if(values.length!==headers.length)throw Error('fee_report_csv_invalid');const r=Object.fromEntries(headers.map((k,i)=>[k,values[i]]));
  if(r.account_id&&r.account_id!==platformAccountId)throw Error('provider_scope_mismatch');
  if(r.currency.toLowerCase()!=='usd')throw Error('fee_report_currency_unsupported');
  const identity={balanceId:r.balance_transaction_id,feeTransactionId:r.fee_transaction_id,incurredBy:r.incurred_by,incurredByType:r.incurred_by_type,product:r.product,feature:r.feature_name,pricingTier:r.pricing_tier??'',incurredAt:r.incurred_at??'',activityStart:r.activity_start_time??'',activityEnd:r.activity_end_time??'',settledVia:r.settled_via,currency:'usd'};
  if(!identity.balanceId||!identity.feeTransactionId)throw Error('fee_report_identity_missing');
  const semanticId=sha256(JSON.stringify(identity));if(seen.has(semanticId))throw Error('fee_report_ambiguous_duplicate_rows');seen.add(semanticId);
  return {semanticId,...identity,amountCents:decimalCents(r.amount),taxCents:decimalCents(r.tax||'0')};
 });
}
export async function downloadStripeReport(url,secret){
 const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.hostname!=='files.stripe.com'||parsed.username||parsed.password)throw Error('fee_report_download_scope');
 if(!secret)throw Error('fee_report_auth_unavailable');
 const response=await fetch(parsed,{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('fee_report_download_unavailable');
 const reader=response.body.getReader();const chunks=[];let bytes=0;
 for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw Error('fee_report_too_large');}chunks.push(value);}
 return Buffer.concat(chunks).toString('utf8');
}
