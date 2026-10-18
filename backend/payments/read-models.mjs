import { z } from "zod";
const cents = z.string().regex(/^(0|[1-9][0-9]*)$/),
  id = z.uuid(),
  date = z.string();
const attemptStatus = z.enum([
  "creating",
  "requires_action",
  "processing",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);
const feePlanSummarySchema=z.strictObject({id,digest:z.string().regex(/^[a-f0-9]{64}$/),estimatedFeeCents:cents,maximumFeeCents:cents,maximumPayerFeeCents:cents,maximumRecipientFeeCents:cents,upfrontCents:cents,actualFeeCents:cents.nullable(),payerRestitutionCents:cents.nullable(),restitutionStatus:z.enum(['not_determined','not_required','owed','queued','dispatching','succeeded','failed','unknown','held']),restoration:z.string()});
export const unknownFundingSchema = z.strictObject({
  coverage: z.literal("unknown"),
  feePlan: feePlanSummarySchema.nullable().optional(),
  receivedCents: z.null(),
  requiredCents: z.null(),
  blockedReasons: z.array(z.string()),
  allowedActions: z.array(z.string()),
  heldCents: cents.nullable(),
  heldCentsMeaning: z.literal(
    "verified_available_cash_under_active_holds_excluding_outbound_reservations",
  ),
});
export const knownFundingSchema = z.strictObject({
  obligationId: id,
  feeRevision: z.strictObject({id,digest:z.string().regex(/^[a-f0-9]{64}$/),maximumTotalFeeCents:cents,supplementalAmountCents:cents,settledActualFeeCents:cents.nullable(),isCurrentEvidence:z.boolean()}).optional(),
  feePlan: feePlanSummarySchema.nullable().optional(),
  paymentRevision: z.number().int().positive(),
  environmentId: id,
  environment: z.enum(["sandbox", "live"]),
  currency: z.literal("USD"),
  termsId: id.nullable(),
  termsRevision: z.number().int().nullable(),
  transactionTermsId: id.nullable(),
  transactionTermsRevision: z.number().int().nullable(),
  estimatedFeeCents: cents,
  actualFeeCents: cents.nullable(),
  feeVarianceCents: z
    .string()
    .regex(/^-?(0|[1-9][0-9]*)$/)
    .nullable(),
  coverage: z.enum(["covered", "insufficient", "held"]),
  requiredCents: cents,
  receivedCents: cents,
  feeState: z
    .enum(["fee_actual_pending", "matched", "fee_variance_pending"])
    .nullable(),
  activeAttempt: z
    .strictObject({ id, operationId: id, status: attemptStatus })
    .nullable(),
  blockedReasons: z.array(z.string()),
  allowedActions: z.array(z.string()),
  heldCents: cents.nullable(),
  heldCentsMeaning: z.literal(
    "verified_available_cash_under_active_holds_excluding_outbound_reservations",
  ),
  transferredCents: cents,
  refundedCents: cents,
  payees: z.array(
    z.strictObject({
      componentId: id,
      allocationComponentId: id.nullable(),
      lotId: id,
      memberId: id,
      milestoneId: id.nullable(),
      grossCents: cents,
      feeCents: cents,
      netCents: cents,
      transferredCents: cents,
      grossSatisfiedCents: cents,
      releaseReady: z.boolean(),
      releaseState: z.string(),
      transferStatus: z.string(),
      transferCapability: z.string().nullable(),
      bankPayout: z.literal("unknown"),
    }),
  ),
  refundRequests: z.array(
    z.strictObject({
      id,
      amountCents: cents,
      status: z.string(),
      revision: z.number().int().positive(),
    }),
  ),
  disputes: z.array(
    z.strictObject({
      id,
      origin: z.enum(["participant", "network"]),
      status: z.string(),
      revision: z.number().int().positive(),
    }),
  ),
});
export const fundingReadSchema = z.union([
  unknownFundingSchema,
  knownFundingSchema,
]);
export const orderPolicyReadSchema = z.strictObject({
  orderTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  paymentRevision: z.number().int().nonnegative(),
  policyVersionId: id.nullable(),
  policyDigest: z.string().nullable(),
  policyStatus: z.enum(["pending", "approved"]).nullable(),
  policy: z.json().nullable(),
  provenance: z.string().nullable(),
  buyerPayableCents: z.number().int().nonnegative().nullable(),
  sellerGrossCents: z.number().int().nonnegative(),
  sellerFeeCents: z.number().int().nonnegative().nullable(),
  sellerNetCents: z.number().int().nullable(),
  confirmations: z.array(id),
});
export const orderPaymentReadSchema = z.union([
  unknownFundingSchema.extend({ financialPolicy: orderPolicyReadSchema }),
  knownFundingSchema.extend({ financialPolicy: orderPolicyReadSchema }),
]);
export const attemptReadSchema = z.strictObject({
  attemptId: id,
  operationId: id,
  obligationId: id,
  status: attemptStatus,
  sessionId: z.string().nullable(),
  chargeId: z.string().nullable(),
  hostedUrl: z.string().nullable(),
  expiresAt: date.nullable(),
});
export const operationReadSchema = z.strictObject({
  operationId: id,
  kind: z.enum([
    "checkout",
    "transfer",
    "refund",
    "fee_restitution",
    "fee_supplement_checkout",
    "reversal",
    "expire",
    "recipient",
    "onboarding",
  ]),
  status: z.enum([
    "queued",
    "dispatching",
    "succeeded",
    "failed",
    "unknown",
    "held",
  ]),
  createdAt: date,
  hostedUrl: z.string().nullable(),
  bankPayout: z.literal("unknown"),
});
export const accountReadSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  transferCapability: z.string(),
  payoutCapability: z.string(),
  observedAt: date.nullable(),
  bankPayout: z.literal("unknown"),
  payoutObservations: z.array(
    z.strictObject({
      payoutId: z.string(),
      status: z.string(),
      observedAt: date,
    }),
  ),
});
