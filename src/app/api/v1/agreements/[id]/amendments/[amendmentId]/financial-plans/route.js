import {api} from "@/lib/backend.mjs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=api({method:"GET"},async({runtime,actor,params})=>runtime.market.amendmentFinancialPlans(actor,params.id,params.amendmentId));
export const POST=api({method:"POST",status:201},async({runtime,actor,params,body,request})=>runtime.market.proposeAmendmentFinancialPlan(actor,params.id,params.amendmentId,body,request.headers.get("idempotency-key")));
