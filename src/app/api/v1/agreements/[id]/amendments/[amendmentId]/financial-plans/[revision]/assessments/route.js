import {api} from "@/lib/backend.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const POST=api({method:"POST",status:200},async({runtime,actor,params,body,request})=>runtime.market.assessAmendmentFinancialPlan(actor,params.id,params.amendmentId,params.revision,body,request.headers.get("idempotency-key")));
