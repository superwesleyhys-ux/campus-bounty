export type Person = { id: string; name: string };
export type ComponentAmount = {
  memberId: string;
  stagePosition: number;
  grossCents: number;
  recipientFeeCents: number;
  netCents: number;
};
export type Plan = {
  members: { memberId: string; units: number }[];
  lots: {
    principalCents: number;
    chargeTotalCents: number;
    components: ComponentAmount[];
  }[];
};
export type FeePlan = {
  context: {
    policyId: string;
    policyDigest: string;
    sourceDigest: string;
    payerId: string;
    participants: string[];
  };
  planId: string | null;
  digest: string | null;
  plan: {
    estimatedFeeCents: number;
    maximumFeeCents: number;
    additionalFeeCapCents: number;
    maximumPayerFeeCents: number;
    maximumRecipientFeeCents: number;
    originalPlan: Plan;
    maximumPlan: Plan;
    restoration: string;
  } | null;
  confirmedParticipantIds: string[];
  allowedActions: string[];
};
export type Quote = {
  quoteId: string;
  quoteDigest: string;
  obligationId: string;
  obligationRevision: number;
  amountCents: number;
  currency: "USD";
  expiresAt: string;
};
export type Funding = {
  coverage: string;
  obligationId?: string;
  paymentRevision?: number;
  termsId?: string;
  termsRevision?: number;
  transactionTermsId?: string;
  transactionTermsRevision?: number;
  receivedCents: string | null;
  requiredCents: string | null;
  heldCents: string | null;
  transferredCents?: string;
  refundedCents?: string;
  actualFeeCents?: string | null;
  allowedActions: string[];
  blockedReasons: string[];
  activeAttempt?: { id: string; operationId: string; status: string } | null;
  payees?: {
    componentId: string;
    memberId: string;
    milestoneId: string | null;
    grossCents: string;
    feeCents: string;
    netCents: string;
    transferredCents: string;
    releaseReady: boolean;
    releaseState: string;
    transferStatus: string;
    transferCapability: string | null;
    bankPayout: string;
  }[];
  feePlan?: {
    restitutionStatus: string;
    payerRestitutionCents: string | null;
  } | null;
  refundRequests?: { id: string; amountCents: string; status: string }[];
  disputes?: { id: string; origin: string; status: string }[];
};
export type PaymentView = {
  kind: "agreement" | "order";
  resourceId: string;
  payerId: string;
  feeReview: {
    revisionId: string;
    state: string;
    isCurrentEvidence: boolean;
    settledActualFeeCents: string | null;
    initialQuoteBlockers: string[];
    restitutions: { source: string; amountCents: string; status: string }[];
  } | null;
  paymentEnabled: boolean;
  configurationChangeBlocker: string | null;
  approvedDisclosures: Record<
    string,
    { title: string; description: string }
  > | null;
  funding: Funding;
  feePlan: FeePlan | null;
  feePlanBlocker: string | null;
  preparationBlocker: string | null;
  people: Person[];
  quoteRequest: Record<string, unknown> | null;
  quote: Quote | null;
  orderPolicy: {
    orderTermsDigest: string;
    paymentRevision: number;
    policyVersionId: string | null;
    policyDigest: string | null;
    buyerPayableCents: number | null;
    sellerGrossCents: number;
    sellerFeeCents: number | null;
    sellerNetCents: number | null;
    confirmations: string[];
    policy: {
      disclosure?: Record<string, { title: string; description: string }>;
    } | null;
  } | null;
  refundSources: {
    chargeId: string;
    amountCents: number;
    policyVersionId: string;
  }[];
};
export type MoneyOperation = {
  operationId: string;
  kind: string;
  status: string;
  hostedUrl: string | null;
};
export type PaymentAttempt = {
  attemptId: string;
  obligationId: string;
  operationId: string;
  status: string;
  hostedUrl: string | null;
  expiresAt: string | null;
};
export function cents(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "Not yet known";
  const n = BigInt(value);
  return `${n < 0n ? "−" : ""}$${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, "0")}`;
}
export function reason(code: string) {
  return (
    (
      {
        payment_configuration_changed_existing_intent:
          "Approved configuration changed. This saved intent keeps its original policy. A never-dispatched quote cannot be rebound; operator lifecycle review is required. Existing unknown payments must be checked or recovered using the original request.",
        payment_configuration_required:
          "An approved payment configuration is needed. The operator must provide account-specific fee, tax and refund terms.",
        payment_configuration_stale:
          "The approved payment configuration needs an operator update.",
        signed_configuration_refresh_required:
          "The signed allocation uses an earlier configuration. Its existing terms remain preserved; new terms need fresh personal agreement.",
        existing_payment_requires_recovery:
          "A payment already exists. Check or recover its original request below.",
        original_money_state_changed:
          "The original agreement’s money or recipient capability changed. Review a fresh financial plan before paying.",
        financial_plan_stale:
          "This financial plan is out of date. Review fresh terms before paying.",
        ordinary_and_financial_consent_required:
          "Every original party must confirm both the work change and its exact financial terms.",
        payment_or_fee_pending:
          "Waiting for confirmed payment and processing-fee facts.",
        payments_unavailable:
          "New payment actions are unavailable in this environment.",
        amount_below_provider_minimum:
          "This exact amount is below the supported payment minimum; no additional charge is invented.",
        recipient_fee_recovery_policy_required:
          "Earlier recipient transfers need a separately approved recovery policy before this fee change can proceed.",
      } as Record<string, string>
    )[code] ?? code.replaceAll("_", " ")
  );
}
