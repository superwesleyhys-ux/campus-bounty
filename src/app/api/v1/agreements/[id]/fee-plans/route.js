import {api} from '@/lib/backend.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=api({method:'GET'},async({runtime,actor,params})=>runtime.market.paymentFeePlan(actor,'agreement',params.id));
export const POST=api({method:'POST'},async({runtime,actor,params,body,request})=>runtime.market.proposePaymentFeePlan(actor,'agreement',params.id,body,request.headers.get('idempotency-key')));
