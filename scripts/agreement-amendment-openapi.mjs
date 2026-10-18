import { z } from "zod";
import {
  proposeAmendmentSchema,
  reviseAmendmentSchema,
  confirmAmendmentSchema,
  endAmendmentSchema,
} from "../backend/modules/agreement-amendments.mjs";
const uuid = { type: "string", format: "uuid" },
  str = { type: "string" },
  bool = { type: "boolean" },
  integer = { type: "integer" },
  positive = { type: "integer", minimum: 1 },
  dateTime = { type: "string", format: "date-time" },
  nil = { type: "null" },
  nullable = (s) => ({ anyOf: [s, nil] }),
  array = (items, maxItems) => ({
    type: "array",
    items,
    ...(maxItems ? { maxItems } : {}),
  }),
  ref = (name) => ({ $ref: "#/components/schemas/" + name });
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export function addAgreementAmendmentOpenapi(spec) {
  const s = spec.components.schemas;
  s.AgreementCapabilities = object({
    agreementAmendments: bool,
    agreementTermsBinding: { enum: ["legacy", "explicit"] },
    schemaRequirement: { const: 17 },
  });
  s.AgreementFunding = object({
    authority: { const: "unavailable" },
    coverage: { const: "unknown" },
    agreementActivation: str,
    requirement: { enum: ["none_for_terms", "funding_reconciliation"] },
    changeKind: { enum: ["none", "increase", "decrease", "reallocation"] },
    rewardDeltaCents: integer,
    additionalFundingCents: nil,
    refundCents: nil,
    allocationChanged: bool,
    canExecutePayment: { const: false },
  });
  s.AgreementStageTerms = object({
    id: uuid,
    position: positive,
    title: str,
    amountCents: positive,
    deliverable: str,
    acceptanceCriteria: nullable(str),
  });
  const legacyStage = object(
    {
      position: positive,
      title: str,
      amount_cents: positive,
      deliverable: str,
      acceptance_criteria: nullable(str),
    },
    ["position", "title", "amount_cents", "deliverable"],
  );
  s.AgreementRawTerms = {
    type: "object",
    description:
      "Verbatim immutable stored snapshot. T1 preserves legacy absent/null fields and snake_case stage definitions; milestone mapping is explicitly supplied alongside it. Server-owned historic fields are preserved.",
    properties: {
      taskTitle: str,
      description: str,
      dueDate: nullable({ type: "string", format: "date" }),
      rewardCents: positive,
      currency: { const: "USD" },
      members: array(uuid),
      milestones: array(
        { oneOf: [legacyStage, ref("AgreementStageTerms")] },
        20,
      ),
    },
    required: [
      "taskTitle",
      "description",
      "rewardCents",
      "currency",
      "members",
      "milestones",
    ],
    additionalProperties: true,
  };
  s.AgreementTerms = object({
    id: uuid,
    agreementId: uuid,
    revision: positive,
    origin: { enum: ["legacy_snapshot", "accepted_application", "amendment"] },
    recordedAt: dateTime,
    sourceApplicationId: nullable(uuid),
    sourceListingVersion: nullable(positive),
    amendmentId: nullable(uuid),
    proposalRevision: nullable(positive),
    terms: ref("AgreementRawTerms"),
    milestones: array(ref("AgreementStageTerms"), 20),
  });
  s.AmendmentParticipant = object({
    userId: uuid,
    role: { enum: ["publisher", "collaborator"] },
    displayName: nullable(str),
    confirmation: nullable(
      object({
        proposalRevision: positive,
        termsId: uuid,
        confirmedAt: dateTime,
      }),
    ),
  });
  const status = {
    enum: [
      "pending",
      "agreed_waiting_funds",
      "effective",
      "rejected",
      "withdrawn",
      "stale_base",
      "stale_work",
      "stale_agreement",
    ],
  };
  s.AgreementAmendment = object({
    id: uuid,
    agreementId: uuid,
    createdSequence: positive,
    proposerId: uuid,
    proposalRevision: positive,
    currentProposalRevision: positive,
    status,
    reason: str,
    baseTerms: ref("AgreementTerms"),
    proposedTerms: ref("AgreementTerms"),
    changedPaths: array(str),
    addedMilestoneIds: array(uuid, 20),
    retiredMilestoneIds: array(uuid, 20),
    participants: array(ref("AmendmentParticipant")),
    allowedActions: object({
      confirm: bool,
      revise: bool,
      reject: bool,
      withdraw: bool,
    }),
    blockedReasons: array(str),
    terminalReason: nullable(str),
    funding: ref("AgreementFunding"),
  });
  s.AmendmentEvent = object({
    id: uuid,
    agreementId: uuid,
    amendmentId: uuid,
    proposalRevision: positive,
    sequence: positive,
    actorId: nullable(uuid),
    operation: {
      enum: [
        "propose",
        "revise",
        "confirm",
        "reject",
        "withdraw",
        "effective",
        "agreed_waiting_funds",
        "stale_base",
        "stale_work",
        "stale_agreement",
        "materialize",
        "retire",
      ],
    },
    oldStatus: nullable(status),
    newStatus: status,
    reason: nullable(str),
    occurredAt: dateTime,
  });
  const receiptBase = {
    operation: { enum: ["propose", "revise", "confirm", "reject", "withdraw"] },
    agreementId: uuid,
    amendmentId: uuid,
    proposalRevision: positive,
    termsId: uuid,
    termsRevision: positive,
    eventId: uuid,
    outcomeAtCommit: status,
  };
  s.AmendmentReceipt = {
    oneOf: [
      object({
        ...receiptBase,
        operation: { enum: ["propose", "revise"] },
        newMilestoneIds: array(
          object({ clientReference: str, id: uuid, position: positive }),
          20,
        ),
      }),
      object({
        ...receiptBase,
        operation: { const: "confirm" },
        confirmation: object({
          amendmentId: uuid,
          proposalRevision: positive,
          userId: uuid,
        }),
      }),
      object({ ...receiptBase, operation: { enum: ["reject", "withdraw"] } }),
    ],
  };
  s.AmendmentCommandResult = object({
    agreement: object({ id: uuid, state: str }),
    effectiveTerms: object({ id: uuid, revision: positive }),
    amendment: object({ id: uuid, proposalRevision: positive, status }),
    receipt: ref("AmendmentReceipt"),
    funding: ref("AgreementFunding"),
  });
  for (const [name, item] of [
    ["AgreementTermsPage", "AgreementTerms"],
    ["AgreementAmendmentsPage", "AgreementAmendment"],
    ["AmendmentEventsPage", "AmendmentEvent"],
  ])
    s[name] = object({
      items: array(ref(item), 50),
      nextCursor: nullable({ type: "string", maxLength: 1024 }),
      limit: { type: "integer", minimum: 1, maximum: 50 },
      effectiveTermsId: uuid,
    });
  s.AmendmentNotificationContext = object({
    agreementId: uuid,
    amendmentId: uuid,
    proposalRevision: positive,
    eventId: uuid,
  });
  s.AgreementPhysicalMilestone = object(
    {
      id: uuid,
      agreement_id: uuid,
      position: positive,
      title: str,
      amount_cents: positive,
      deliverable: str,
      acceptance_criteria: nullable(str),
      state: {
        enum: ["pending", "submitted", "revision_requested", "accepted"],
      },
      version: { type: "integer", minimum: 0 },
      revision: positive,
      latest_submission_id: nullable(uuid),
      accepted_submission_id: nullable(uuid),
      effectiveTerms: nullable(ref("AgreementStageTerms")),
      lifecycle: { enum: ["included", "retired"] },
      protectedWork: bool,
    },
    [
      "id",
      "agreement_id",
      "position",
      "title",
      "amount_cents",
      "deliverable",
      "acceptance_criteria",
      "state",
      "version",
      "revision",
      "latest_submission_id",
      "accepted_submission_id",
    ],
  );
  s.AgreementSubmission = object(
    {
      id: uuid,
      milestone_id: uuid,
      author_id: uuid,
      version: positive,
      content: str,
      created_at: dateTime,
      submissionTermsId: uuid,
      submissionTermsRevision: positive,
      termsProvenance: {
        enum: [
          "legacy_original_snapshot_binding",
          "legacy_client_original_binding",
          "explicit_terms_binding",
        ],
      },
      submissionTerms: ref("AgreementTerms"),
      milestoneTerms: ref("AgreementStageTerms"),
    },
    ["id", "milestone_id", "author_id", "version", "content", "created_at"],
  );
  s.FulfillmentResult.properties.milestone = ref("AgreementPhysicalMilestone");
  s.FulfillmentResult.properties.submission = nullable(
    ref("AgreementSubmission"),
  );
  s.FulfillmentResult.properties.effectiveTerms = ref("AgreementTerms");
  s.MilestoneReview.properties.submission = ref("AgreementSubmission");
  const requests = {
    "/agreements/{id}/amendments": proposeAmendmentSchema,
    "/agreements/{id}/amendments/{amendmentId}/revisions":
      reviseAmendmentSchema,
    "/agreements/{id}/amendments/{amendmentId}/confirmations":
      confirmAmendmentSchema,
    "/agreements/{id}/amendments/{amendmentId}/rejections": endAmendmentSchema,
    "/agreements/{id}/amendments/{amendmentId}/withdrawals": endAmendmentSchema,
  };
  const reads = {
    "/capabilities": "AgreementCapabilities",
    "/agreements/{id}/terms": "AgreementTermsPage",
    "/agreements/{id}/terms/{revision}": "AgreementTerms",
    "/agreements/{id}/amendments": "AgreementAmendmentsPage",
    "/agreements/{id}/amendments/{amendmentId}": "AgreementAmendment",
    "/agreements/{id}/amendments/{amendmentId}/events": "AmendmentEventsPage",
  };
  const errorCodes = {
    403: [
      "account_locked",
      "account_restricted",
      "membership_required",
      "not_proposer",
      "not_party",
    ],
    404: ["not_found"],
    409: [
      "live_amendment_exists",
      "stale_effective_revision",
      "stale_proposal_revision",
      "protected_milestone",
      "stale_work",
      "agreement_closed",
      "invalid_state",
      "idempotency_conflict",
      "terms_refresh_required",
      "milestone_retired",
    ],
    422: [
      "invalid_input",
      "invalid_milestone_budget",
      "no_change",
      "invalid_milestone_set",
    ],
    503: ["agreement_amendments_unavailable"],
  };
  for (const [path, ops] of Object.entries(spec.paths))
    for (const [verb, op] of Object.entries(ops)) {
      if (!(path in reads) && !(path in requests)) continue;
      const schema = verb === "post" ? "AmendmentCommandResult" : reads[path];
      if (!schema) continue;
      for (const [code, res] of Object.entries(op.responses))
        if (code.startsWith("2"))
          res.content["application/json"].schema = ref(schema);
      op.parameters = (op.parameters ?? []).map((p) =>
        p.in === "path"
          ? { ...p, schema: p.name === "revision" ? positive : uuid }
          : p,
      );
      if (verb === "post")
        op.requestBody = {
          required: true,
          content: {
            "application/json": { schema: z.toJSONSchema(requests[path]) },
          },
        };
      if (verb === "get" && schema.endsWith("Page"))
        op.parameters.push(
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            schema: {
              type: "string",
              minLength: 1,
              maxLength: 1024,
              pattern: "^[A-Za-z0-9_-]+$",
            },
            description:
              "Canonical actor/agreement/stream/amendment-bound keyset. Proposal list uses immutable lastCreatedSequence, terms uses lastRevision, events uses lastSequence. Descending limit+1; no offset.",
          },
        );
      if (schema === "AgreementAmendment")
        op.parameters.push({
          name: "proposalRevision",
          in: "query",
          schema: positive,
        });
      for (const [status, codes] of Object.entries(errorCodes))
        op.responses[status] = {
          description: codes.join(", "),
          content: {
            "application/problem+json": {
              schema: object({
                type: str,
                title: str,
                status: { const: Number(status) },
                code: { enum: codes },
                detail: str,
                requestId: str,
              }),
            },
          },
        };
      op.description =
        "Authenticated original-party resource. 001–016 returns 503 for new reads/commands. 017 keeps history readable while mutation capability is disabled; an authorized exact successful receipt can recover while disabled. Strict work binding latches permanently after activation. Author is unconfirmed until explicit exact-revision confirmation; all frozen members and publisher must confirm individually. Monetary or allocation changes await unavailable funding authority and never activate an agreement. Historical receipt and fresh current projection are distinct. Existing session, Host/Origin, JSON, 64KiB and rate limits apply.";
    }
  // Extend existing resource contracts additively. Legacy clients retain their raw fields.
  for (const name of ["AgreementOverview"])
    if (s[name])
      Object.assign(s[name].properties, {
        ...s.AgreementCapabilities.properties,
        originalTerms: ref("AgreementTerms"),
        effectiveTerms: ref("AgreementTerms"),
        originalRewardCents: positive,
        currentRewardCents: positive,
        funding: ref("AgreementFunding"),
        amendmentSummary: nullable(
          object({ id: uuid, proposalRevision: positive, status }),
        ),
      });
  if (s.Notification) {
    s.Notification.properties.amendmentContext = nullable(
      ref("AmendmentNotificationContext"),
    );
    s.Notification.required.push("amendmentContext");
    const anchor = s.Notification.properties.navigationAnchor;
    s.Notification.properties.navigationAnchor = {
      anyOf: [
        anchor,
        object({
          type: { const: "amendment" },
          ...s.AmendmentNotificationContext.properties,
        }),
      ],
    };
  }
  const agreementFields = {
    id: uuid,
    task_id: uuid,
    application_id: uuid,
    owner_id: uuid,
    captain_id: uuid,
    team_id: nullable(uuid),
    terms: ref("AgreementRawTerms"),
    state: str,
    created_at: dateTime,
    ...s.AgreementCapabilities.properties,
    originalTerms: ref("AgreementTerms"),
    effectiveTerms: ref("AgreementTerms"),
    originalRewardCents: positive,
    currentRewardCents: positive,
    funding: ref("AgreementFunding"),
    amendmentSummary: nullable(
      object({ id: uuid, proposalRevision: positive, status }),
    ),
    milestone_counts: s.AgreementOverview.properties.milestone_counts,
    members: array(object({ user_id: uuid })),
    milestones: array(ref("AgreementPhysicalMilestone")),
  };
  s.AgreementDetail = object(agreementFields, [
    "id",
    "task_id",
    "application_id",
    "owner_id",
    "captain_id",
    "team_id",
    "terms",
    "state",
    "created_at",
    "members",
    "milestones",
    "agreementAmendments",
    "agreementTermsBinding",
    "schemaRequirement",
  ]);
  for (const [statusCode, res] of Object.entries(
    spec.paths["/agreements/{id}"].get.responses,
  ))
    if (statusCode.startsWith("2"))
      res.content["application/json"].schema = ref("AgreementDetail");
  s.ApplicationTermsResult.properties.agreement = {
    type: "object",
    properties: agreementFields,
    required: [
      "id",
      "state",
      "terms",
      "agreementAmendments",
      "agreementTermsBinding",
      "schemaRequirement",
    ],
    additionalProperties: false,
  };
  for (const [path, ops] of Object.entries(spec.paths))
    if (path.startsWith("/milestones/"))
      for (const [verb, op] of Object.entries(ops)) {
        if (verb === "get" && path.endsWith("/submissions"))
          for (const [statusCode, res] of Object.entries(op.responses))
            if (statusCode.startsWith("2"))
              res.content["application/json"].schema = array(
                ref("AgreementSubmission"),
              );
        op.description +=
          " After strict binding activation, new submissions require expectedEffectiveTermsId/expectedEffectiveRevision. Reviews require submissionTermsId/submissionTermsRevision matching that immutable submission, even after a newer effective agreement. Fresh missing fields return409 terms_refresh_required; exact old normalized successful receipts recover before new-field checks. Disabling amendments cannot disable strict binding. Added submissionTerms/milestoneTerms fields preserve historical criteria and amount.";
      }
}
