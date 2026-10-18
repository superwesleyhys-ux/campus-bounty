const str = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  integer = { type: "integer", minimum: 0 },
  positive = { type: "integer", minimum: 1 },
  revision = { type: "integer", minimum: 1, maximum: 2147483646 },
  bool = { type: "boolean" },
  nil = { type: "null" },
  nullable = (s) => ({ anyOf: [s, nil] }),
  array = (items) => ({ type: "array", items }),
  ref = (name) => ({ $ref: `#/components/schemas/${name}` }),
  object = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
export function addTransactionTermsOpenapi(spec) {
  const s = spec.components.schemas;
  const component = object({
    memberId: uuid,
    milestoneId: str,
    stagePosition: positive,
    grossCents: integer,
    recipientFeeCents: nullable(integer),
    netCents: nullable(integer),
  });
  const plan = object({
    calculationVersion: { const: "charge_member_stage_v1" },
    currency: { const: "USD" },
    platformServiceFeeCents: { const: 0 },
    roundingRule: str,
    members: array(object({ memberId: uuid, units: integer })),
    lots: array(
      object({
        fundingPlanLotId: uuid,
        principalCents: integer,
        estimatedProcessorFeeCents: nullable(integer),
        publisherProcessorFeeCents: nullable(integer),
        recipientProcessorFeeCents: nullable(integer),
        chargeTotalCents: nullable(integer),
        components: array(component),
      }),
    ),
    digest: str,
  });
  const policyText = {
    ...object({
      policyId: str,
      version: str,
      title: str,
      description: str,
    }),
    additionalProperties: true,
  };
  s.TransactionPolicySnapshot = object({
    policyId: uuid,
    provenance: str,
    payload: {
      type: "object",
      properties: {
        disclosure: {
          ...object({
            format: { const: "transaction_policy_disclosure_v1" },
            feeAdjustment: policyText,
            tax: policyText,
            refund: policyText,
          }),
          additionalProperties: true,
        },
      },
      required: ["disclosure"],
    },
  });
  s.AllocationRevision = object({
    id: uuid,
    application_id: uuid,
    revision: positive,
    listing_version: positive,
    task_revision: positive,
    proposer_id: uuid,
    ratios: array(object({ memberId: uuid, units: positive })),
    plan,
    digest: str,
    policy_id: nullable(uuid),
    policy_snapshot: nullable(ref("TransactionPolicySnapshot")),
    previous_id: nullable(uuid),
    created_at: str,
  });
  s.AllocationConfirmation = object({
    application_id: uuid,
    allocation_id: uuid,
    allocation_revision: positive,
    user_id: uuid,
    digest: str,
    consent_kind: { enum: ["ratios_only", "financial_terms"] },
    confirmed_at: str,
  });
  s.AllocationProjection = object({
    applicationId: uuid,
    applicantId: uuid,
    publisherId: uuid,
    state: str,
    releasePolicy: nullable({ enum: ["per_milestone", "final_completion"] }),
    termsVersion: positive,
    taskRevision: positive,
    members: array(
      object({ user_id: uuid, display_name: nullable(str), confirmed: bool }),
    ),
    current: nullable(ref("AllocationRevision")),
    history: array(ref("AllocationRevision")),
    historyNext: nullable(positive),
    confirmations: array(ref("AllocationConfirmation")),
    policies: array(
      object({
        id: uuid,
        status: { enum: ["pending", "approved"] },
        disclosure_ready: bool,
        provenance: str,
        payload: { type: "object" },
      }),
    ),
    blockedReasons: array(str),
    financialConsentAvailable: bool,
    financialExecution: { const: false },
  });
  s.AllocationCommandResult = object({
    receipt: object({ id: uuid, allocationRevision: positive }),
    replayed: bool,
    current: ref("AllocationProjection"),
  });
  s.TransactionCapabilities = object(
    {
      ...s.AgreementCapabilities.properties,
      transactionTerms: bool,
      transactionSchemaRequirement: { const: 18 },
      financialExecution: { const: false },
      feeEstimate: { const: "pending_policy" },
      fullUpfront: { const: true },
      platformServiceFeeCents: { const: 0 },
      payments: object({
        enabled: { const: false },
        environment: { const: "unavailable" },
        schemaRequirement: { const: 20 },
        policyReadiness: { const: "pending_decisions" },
        providerReadiness: { const: "unverified" },
      }),
    },
    [
      ...s.AgreementCapabilities.required,
      "transactionTerms",
      "transactionSchemaRequirement",
      "financialExecution",
      "feeEstimate",
      "payments",
    ],
  );
  s.AgreementTransaction = object(
    {
      releasePolicy: nullable({ enum: ["per_milestone", "final_completion"] }),
      provenance: { enum: ["not_recorded", "exact_allocation"] },
      financialExecution: { const: false },
      bindings: array(
        object({
          agreement_id: uuid,
          terms_id: uuid,
          terms_revision: positive,
          transaction_terms_id: uuid,
          transaction_terms_revision: positive,
          provenance: str,
        }),
      ),
      terms: array(
        object({
          id: uuid,
          agreement_id: uuid,
          revision: positive,
          application_id: uuid,
          allocation_id: uuid,
          allocation_revision: positive,
          listing_version: positive,
          release_policy: { enum: ["per_milestone", "final_completion"] },
          policy_id: uuid,
          policy_snapshot: nullable(ref("TransactionPolicySnapshot")),
          plan,
          digest: str,
          created_at: str,
        }),
      ),
      allocations: array(
        object({
          component_id: uuid,
          funding_plan_lot_id: uuid,
          source_plan_revision: positive,
          agreement_id: uuid,
          transaction_terms_id: uuid,
          transaction_terms_revision: positive,
          terms_id: uuid,
          milestone_id: uuid,
          member_id: uuid,
          stage_position: positive,
          gross_cents: integer,
          recipient_fee_cents: integer,
          net_cents: integer,
        }),
      ),
    },
    ["releasePolicy", "provenance", "financialExecution"],
  );
  for (const name of [
    "AgreementDetail",
    "AgreementOverview",
    "WorkspaceAgreement",
  ])
    if (s[name]?.properties)
      s[name].properties.transaction = ref("AgreementTransaction");
  for (const [name, v] of Object.entries(s))
    if (v.properties?.reward_cents)
      v.properties.release_policy = nullable({
        enum: ["per_milestone", "final_completion"],
      });
  for (const [path, methods] of Object.entries(spec.paths))
    for (const [verb, op] of Object.entries(methods)) {
      const allocation =
        path === "/applications/{id}/allocations" ||
        path === "/applications/{id}/allocations/{revision}/confirmations";
      if (!allocation && path !== "/capabilities") continue;
      if (allocation) {
        for (const parameter of op.parameters || [])
          if (parameter.in === "path" && parameter.name === "revision")
            parameter.schema = revision;
        op.description =
          "Immutable allocation proposal, personal confirmation and history. Positive recipient ratios sum to 10000; zero shares are not approved. A policy-free revision is ratios-only consent and blocks acceptance. Exact financial policy must be separately owner approved. Fresh source/allocation versions, current actor and frozen roster checked; no money execution or provider calls. Retries preserve the original body/key and return original receipt plus fresh authorized current projection.";
        if (verb === "get")
          op.parameters.push({
            name: "beforeRevision",
            in: "query",
            schema: positive,
            description:
              "Exclusive history cursor; current remains the latest revision. History pages contain at most 20 revisions.",
          });
      }
      for (const [code, response] of Object.entries(op.responses))
        if (code.startsWith("2"))
          response.content["application/json"].schema = ref(
            path === "/capabilities"
              ? "TransactionCapabilities"
              : verb === "get"
                ? "AllocationProjection"
                : "AllocationCommandResult",
          );
    }
}
