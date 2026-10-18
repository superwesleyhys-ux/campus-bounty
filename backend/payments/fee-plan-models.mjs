import {z} from 'zod';
const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),amount=z.number().int().nonnegative();
export const feePlanProposalSchema=z.strictObject({policyVersionId:id,policyDigest:hash,sourceDigest:hash});
export const feePlanConfirmationSchema=z.strictObject({digest:hash});
export const feeContextSchema=z.strictObject({environmentId:id,aggregateType:z.enum(['agreement','order']),aggregateId:id,policyId:id,policyDigest:hash,policyVersion:z.number().int().positive(),policyProvenance:z.string(),sourceDigest:hash,payerId:id,participants:z.array(id),originalPlan:z.json()});
export const feePlanBodySchema=feeContextSchema.extend({format:z.literal('capped_actual_fee_plan_v1'),currency:z.literal('USD'),estimatedFeeCents:amount,additionalFeeCapCents:amount,maximumFeeCents:amount,estimatedPayerFeeCents:amount,maximumPayerFeeCents:amount,estimatedRecipientFeeCents:amount,maximumRecipientFeeCents:amount,maximumPlan:z.json(),restoration:z.string(),platformServiceFeeCents:z.literal(0)});
export const feePlanReadSchema=z.strictObject({context:feeContextSchema,planId:id.nullable(),digest:hash.nullable(),plan:feePlanBodySchema.nullable(),confirmedParticipantIds:z.array(id),allowedActions:z.array(z.enum(['propose_fee_plan','confirm_fee_plan','request_quote']))});
export const feePlanProposalResponseSchema=z.strictObject({receipt:z.strictObject({planId:id,digest:hash}),current:feePlanReadSchema});
export const feePlanConfirmationResponseSchema=z.strictObject({receipt:z.strictObject({planId:id,digest:hash,userId:id}),current:feePlanReadSchema});
