import {z} from 'zod';
import {fundingReadSchema,attemptReadSchema,accountReadSchema} from './read-models.mjs';
const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),amount=z.number().int().nonnegative();
const quoteBase={obligationId:id,environmentId:id,policyId:id,policyDigest:hash,policyVersion:z.number().int().positive(),policyProvenance:z.string(),principalCents:amount,chargeTotalCents:amount,currency:z.literal('USD'),feePlanId:id.optional(),feePlanDigest:hash.optional(),feePlan:z.json().optional()};
export const quoteBodySchema=z.union([
 z.strictObject({...quoteBase,termsId:id,termsRevision:z.number().int().positive(),transactionTermsId:id,transactionTermsRevision:z.number().int().positive(),allocationRevision:z.number().int().positive(),sourceDigest:hash,plan:z.json()}),
 z.strictObject({...quoteBase,orderId:id,orderTermsDigest:hash,policy:z.json()}),
]);
export const quoteReceiptSchema=z.strictObject({quoteId:id,quoteDigest:hash,obligationId:id,obligationRevision:z.number().int().positive(),expiresAt:z.string(),quote:quoteBodySchema});
export const attemptReceiptSchema=z.strictObject({attemptId:id,operationId:id,obligationId:id,quoteId:id,amountCents:amount,currency:z.literal('USD'),environment:z.enum(['sandbox','live'])});
const response=(receipt,current=fundingReadSchema)=>z.strictObject({receipt,current});
export const paymentCommandSchemas={
 money_agreement_quote:response(quoteReceiptSchema),
 money_order_quote:response(quoteReceiptSchema),
 money_order_confirm:response(z.strictObject({orderId:id,policyVersionId:id,policyDigest:hash,userId:id})),
 money_cancel_order:response(z.strictObject({orderId:id,state:z.enum(['pending_payment','cancelled','expired']),resolution:z.enum(['open','cancellation_requested','expiry_resolving','paid','compensation_review','terminal'])})),
 money_refund_request:response(z.strictObject({requestId:id,status:z.literal('requested'),refundStatus:z.literal('not_executed')})),
 money_open_dispute:response(z.strictObject({caseId:id,status:z.literal('open'),financialDecision:z.literal('pending')})),
 money_attempt:response(attemptReceiptSchema,attemptReadSchema),
 money_onboarding:response(z.strictObject({operationId:id,status:z.literal('queued')}),accountReadSchema),
};
