import {z,parse,uuid} from './common.mjs';
import {account,member,idempotent} from '../db/store.mjs';
import {moneySql} from './payments.mjs';
import {Problem} from '../errors.mjs';
const positive=z.number().int().positive();
const exact={expectedEffectiveTermsId:z.uuid(),expectedEffectiveRevision:positive,expectedProposalRevision:positive,proposedTermsId:z.uuid(),proposedTermsRevision:positive};
export const financialProposalSchema=z.strictObject({...exact,policyVersionId:z.uuid(),policyDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export const financialExactSchema=z.strictObject({...exact,digest:z.string().regex(/^[a-f0-9]{64}$/)});
export const financialConfirmationSchema=financialExactSchema.extend({feePlanDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export const financialCancellationSchema=financialExactSchema.extend({reason:z.string().trim().min(1).max(2000)});

const amount=z.number().int().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.uuid();
const componentSchema=z.strictObject({id,memberId:id,milestoneId:id,stagePosition:positive,grossCents:amount,recipientFeeCents:amount,netCents:amount});
const incrementSchema=z.strictObject({calculationVersion:z.literal('charge_member_stage_v1'),currency:z.literal('USD'),platformServiceFeeCents:z.literal(0),roundingRule:z.literal('largest_remainder_uuid_stage;odd_fee_cent_publisher'),members:z.array(z.strictObject({memberId:id,units:positive})),lots:z.array(z.strictObject({fundingPlanLotId:id,principalCents:amount,estimatedProcessorFeeCents:amount,publisherProcessorFeeCents:amount,recipientProcessorFeeCents:amount,chargeTotalCents:amount,components:z.array(componentSchema)})).length(1),digest:hash.optional()});
const profileSchema=z.strictObject({kind:z.enum(['stripe_usd_card_minimum_v1','synthetic_usd_card_minimum_v1']),presentmentCurrency:z.literal('USD'),settlementCurrency:z.literal('USD'),paymentMethodTypes:z.tuple([z.literal('card')]),minimumChargeCents:z.literal(50),source:z.literal('https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts'),accountEvidenceDigest:hash,accountEvidenceRef:z.string()});
const planSchema=z.strictObject({format:z.literal('amendment_financial_plan_v1'),planId:id,agreementId:id,amendmentId:id,proposalRevision:positive,baseTermsId:id,baseRevision:positive,proposedTermsId:id,proposedTermsRevision:positive,baseTransactionTermsId:id,baseTransactionTermsRevision:positive,environmentId:id,policyId:id,policyDigest:hash,policyVersion:positive,policy:z.json(),collectionProfileId:id,collectionProfileDigest:hash,collectionProfile:profileSchema,participants:z.array(id),protectedComponentIds:z.array(id),baselineDigest:hash,releasePolicy:z.enum(['per_milestone','final_completion']),currency:z.literal('USD'),principalCents:amount,estimatedProcessorFeeCents:amount,publisherProcessorFeeCents:amount,recipientProcessorFeeCents:amount,extraFeeCapCents:amount,chargeTotalCents:amount,maximumFeeCents:amount,restoration:z.string(),minimumChargeCents:z.literal(50),plan:incrementSchema});
const feeSchema=z.strictObject({format:z.literal('capped_actual_fee_plan_v1'),environmentId:id,aggregateType:z.literal('amendment'),aggregateId:id,policyId:id,policyDigest:hash,sourceDigest:hash,payerId:id,participants:z.array(id),currency:z.literal('USD'),originalPlan:incrementSchema,estimatedFeeCents:amount,additionalFeeCapCents:amount,maximumFeeCents:amount,estimatedPayerFeeCents:amount,maximumPayerFeeCents:amount,estimatedRecipientFeeCents:amount,maximumRecipientFeeCents:amount,maximumPlan:incrementSchema,restoration:z.string(),platformServiceFeeCents:z.literal(0)});
export const financialReadSchema=z.strictObject({agreementId:z.uuid(),amendmentId:z.uuid(),plans:z.array(z.strictObject({planId:z.uuid(),revision:positive,digest:z.string(),feePlanDigest:z.string(),feePlan:feeSchema,plan:planSchema,confirmedParticipantIds:z.array(z.uuid()),obligationId:z.uuid().nullable(),funded:z.boolean(),effective:z.boolean(),blockedReasons:z.array(z.string()),allowedActions:z.array(z.enum(['refresh','confirm_financial_plan','request_quote','assess','activate','request_cancellation']))})),financialPolicyLimits:z.array(z.string())});
const receipt=z.strictObject({planId:z.uuid(),revision:positive,digest:z.string()});
const assessment=receipt.extend({assessmentId:z.uuid(),status:z.enum(['ready','blocked']),reason:z.string().nullable()});
export const financialResponses={
 propose:z.strictObject({receipt,current:financialReadSchema}),
 confirm:z.strictObject({receipt:receipt.extend({userId:z.uuid()}),current:financialReadSchema}),
 quote:z.strictObject({receipt:z.strictObject({quoteId:z.uuid(),quoteDigest:z.string(),obligationId:z.uuid(),obligationRevision:positive,expiresAt:z.string(),amountCents:positive,currency:z.literal('USD')}),current:financialReadSchema}),
 assess:z.strictObject({receipt:assessment,current:financialReadSchema}),
 activate:z.strictObject({receipt:z.union([assessment,receipt.extend({status:z.literal('effective'),assessmentId:z.uuid(),transactionTermsId:z.uuid()})]),current:financialReadSchema}),
 cancel:z.strictObject({receipt:receipt.extend({status:z.literal('cancellation_requested')}),current:financialReadSchema})
};
export function amendmentMoneyModule(store,{paymentEnabled=false}={}){
 async function read(c,gid,aid){
  if(!(await c.query("SELECT to_regprocedure('campus.amend_money_read(uuid,uuid)') IS NOT NULL ready")).rows[0].ready)throw new Problem(503,'amendment_money_unavailable','Amendment funding requires the current payment schema.');
  const v=financialReadSchema.parse((await moneySql(c,'SELECT campus.amend_money_read($1,$2) result',[gid,aid])).rows[0].result);
  return paymentEnabled?v:{...v,plans:v.plans.map(p=>({...p,allowedActions:['refresh'],blockedReasons:[...p.blockedReasons,'payments_unavailable']}))};
 }
 async function command(actor,gid,aid,revision,input,key,kind){uuid(gid);uuid(aid);if(revision!==null)revision=parse(positive,Number(revision));
  if(!paymentEnabled)throw new Problem(503,'payments_unavailable','New payment actions are unavailable.');
  const d=parse({propose:financialProposalSchema,confirm:financialConfirmationSchema,cancel:financialCancellationSchema}[kind]??financialExactSchema,input);
  return store.as(actor,async c=>{await account(c,actor);await member(c,actor,{write:true});await read(c,gid,aid);
   await moneySql(c,'SELECT campus.authorize_agreement_amendment($1)',[gid]);
   const r=await idempotent(c,actor,`amendment.money.${kind}:${gid}:${aid}:${revision??''}`,key,d,async()=>{
    const args=kind==='propose'?[gid,aid,JSON.stringify(d)]:[gid,aid,revision,JSON.stringify(d)];
    return (await moneySql(c,`SELECT campus.amend_money_${kind}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
   });
   await member(c,actor,{write:true});await moneySql(c,'SELECT campus.authorize_agreement_amendment($1)',[gid]);
   return financialResponses[kind].parse({receipt:r,current:await read(c,gid,aid)});
  });
 }
 return {amendmentFinancialPlans:async(actor,gid,aid)=>{uuid(gid);uuid(aid);return store.as(actor,async c=>{await account(c,actor);return read(c,gid,aid);});},proposeAmendmentFinancialPlan:(a,g,m,d,k)=>command(a,g,m,null,d,k,'propose'),confirmAmendmentFinancialPlan:(a,g,m,r,d,k)=>command(a,g,m,r,d,k,'confirm'),quoteAmendmentFinancialPlan:(a,g,m,r,d,k)=>command(a,g,m,r,d,k,'quote'),assessAmendmentFinancialPlan:(a,g,m,r,d,k)=>command(a,g,m,r,d,k,'assess'),activateAmendmentFinancialPlan:(a,g,m,r,d,k)=>command(a,g,m,r,d,k,'activate'),cancelAmendmentFinancialPlan:(a,g,m,r,d,k)=>command(a,g,m,r,d,k,'cancel')};
}
