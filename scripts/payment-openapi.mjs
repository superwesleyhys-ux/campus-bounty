import {
  preparationSchema,
  preparationReceiptSchema,
  recipientPreparationReceiptSchema,
  participantPaymentSchema,
} from "../backend/payments/preparation-models.mjs";
import {
  feeRevisionProposalSchema,
  feeRevisionConfirmationSchema,
  feeRevisionStartSchema,
  feeRevisionReadSchema,
  feeRevisionResponses,
} from "../backend/payments/fee-revision-models.mjs";
import {
  feePlanProposalSchema,
  feePlanConfirmationSchema,
  feePlanReadSchema,
  feePlanProposalResponseSchema,
  feePlanConfirmationResponseSchema,
} from "../backend/payments/fee-plan-models.mjs";
import { paymentCommandSchemas } from "../backend/payments/command-models.mjs";
import {
  fundingReadSchema,
  orderPaymentReadSchema,
  accountReadSchema,
  attemptReadSchema,
  operationReadSchema,
} from "../backend/payments/read-models.mjs";
import { z } from "zod";
import {
  paymentQuoteSchema,
  paymentAttemptSchema,
  orderPaymentQuoteSchema,
  paymentPolicyConfirmationSchema,
  paymentCancellationSchema,
  onboardingSchema,
  refundRequestSchema,
  disputeSchema,
} from "../backend/modules/payments.mjs";
export function addPaymentOpenapi(spec) {
  // Keep each generated definition under its own component and rebase every
  // local pointer, including Zod's recursive JSON value definitions.
  function component(name, schema) {
    const json = z.toJSONSchema(schema);
    function rebase(v) {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "$ref" && typeof x === "string" && x.startsWith("#/"))
          v[k] = "#/components/schemas/" + name + x.slice(1);
        else rebase(x);
      }
    }
    rebase(json);
    spec.components ??= {};
    spec.components.schemas ??= {};
    spec.components.schemas[name] = json;
    return { $ref: "#/components/schemas/" + name };
  }
  for (const path of [
    "/applications/{id}/payment-preparation",
    "/agreements/{id}/payment-preparation",
    "/orders/{id}/payment-preparation",
    "/funding-obligations/{id}/payment-preparation",
    "/agreements/{id}/amendments/{amendmentId}/payment-preparation",
    "/me/payment-account/preparation",
  ]) {
    const op = spec.paths["/api/v1" + path]?.post ?? spec.paths[path]?.post;
    if (!op) throw Error("Undocumented preparation " + path);
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: component("PaymentPreparationRequest", preparationSchema),
        },
      },
    };
    op.responses["200"] = {
      description: "Actor-bound immutable server-derived preparation receipt",
      headers: {
        "X-Campus-Mutation-Receipt": {
          schema: { type: "string" },
          description:
            "SHA-256 of actor, path, idempotency key and parsed body; business receipt identity must also be checked.",
        },
      },
      content: {
        "application/json": {
          schema: component(
            path.includes("/me/")
              ? "RecipientPreparationResponse"
              : "PaymentPreparationResponse",
            z.strictObject({
              receipt: path.includes("/me/")
                ? recipientPreparationReceiptSchema
                : preparationReceiptSchema,
            }),
          ),
        },
      },
    };
  }
  const reads = {
    "/agreements/{id}/participant-payment": participantPaymentSchema,
    "/orders/{id}/participant-payment": participantPaymentSchema,
    "/funding-obligations/{id}/fee-revisions": feeRevisionReadSchema,
    "/agreements/{id}/fee-plans": feePlanReadSchema,
    "/orders/{id}/fee-plans": feePlanReadSchema,
    "/agreements/{id}/funding": fundingReadSchema,
    "/orders/{id}/payment": orderPaymentReadSchema,
    "/me/payment-account": accountReadSchema,
    "/payment-attempts/{id}": attemptReadSchema,
    "/money-operations/{id}": operationReadSchema,
  };
  for (const [path, schema] of Object.entries(reads)) {
    const op = spec.paths["/api/v1" + path]?.get ?? spec.paths[path]?.get;
    if (!op) throw Error("Undocumented payment read " + path);
    op.responses["200"] = {
      description:
        "Participant-scoped current persisted state; null is unknown, bank payout is separate",
      content: {
        "application/json": {
          schema: component(
            "PaymentRead" + Object.keys(reads).indexOf(path),
            schema,
          ),
        },
      },
    };
  }
  const bindings = {
    "/agreements/{id}/payment-quotes": paymentQuoteSchema,
    "/orders/{id}/payment-quotes": orderPaymentQuoteSchema,
    "/orders/{id}/payment-policy-confirmations":
      paymentPolicyConfirmationSchema,
    "/funding-obligations/{id}/payment-attempts": paymentAttemptSchema,
    "/me/payment-account/onboarding": onboardingSchema,
    "/agreements/{id}/refund-requests": refundRequestSchema,
    "/orders/{id}/refund-requests": refundRequestSchema,
    "/agreements/{id}/disputes": disputeSchema,
    "/orders/{id}/disputes": disputeSchema,
  };
  const commandNames = {
    "/agreements/{id}/payment-quotes": "money_agreement_quote",
    "/orders/{id}/payment-quotes": "money_order_quote",
    "/orders/{id}/payment-policy-confirmations": "money_order_confirm",
    "/funding-obligations/{id}/payment-attempts": "money_attempt",
    "/me/payment-account/onboarding": "money_onboarding",
    "/agreements/{id}/refund-requests": "money_refund_request",
    "/orders/{id}/refund-requests": "money_refund_request",
    "/agreements/{id}/disputes": "money_open_dispute",
    "/orders/{id}/disputes": "money_open_dispute",
  };
  for (const [path, schema] of Object.entries(bindings)) {
    const op = spec.paths["/api/v1" + path]?.post ?? spec.paths[path]?.post;
    if (!op) throw Error("Undocumented payment route " + path);
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: component(
            "PaymentRequest" + Object.keys(bindings).indexOf(path),
            schema,
          ),
        },
      },
    };
    delete op.responses["200"];
    delete op.responses["202"];
    op.responses[commandNames[path] === "money_attempt" ? "202" : "200"] = {
      description:
        "Immutable receipt and fresh participant-scoped current state",
      content: {
        "application/json": {
          schema: component(
            "PaymentCommand_" + commandNames[path],
            paymentCommandSchemas[commandNames[path]],
          ),
        },
      },
    };
    op.description =
      "Exact actor/resource-scoped payment command. Immutable receipt and fresh current projection are separate. Unknown outcomes retain the same operation/key; never start another payment to recover. Refund and dispute commands create review requests only.";
  }
  for (const [path, request, response] of [
    [
      "/agreements/{id}/fee-plans",
      feePlanProposalSchema,
      feePlanProposalResponseSchema,
    ],
    [
      "/orders/{id}/fee-plans",
      feePlanProposalSchema,
      feePlanProposalResponseSchema,
    ],
    [
      "/payment-fee-plans/{id}/confirmations",
      feePlanConfirmationSchema,
      feePlanConfirmationResponseSchema,
    ],
  ]) {
    const op = spec.paths["/api/v1" + path]?.post ?? spec.paths[path]?.post;
    if (!op) throw Error("Undocumented fee plan " + path);
    const name = path.includes("confirmations")
      ? "FeePlanConfirmation"
      : "FeePlanProposal";
    op.requestBody = {
      required: true,
      content: {
        "application/json": { schema: component(name + "Request", request) },
      },
    };
    op.responses["200"] = {
      description:
        "Exact personal fee consent receipt and freshly authorized plan",
      content: {
        "application/json": { schema: component(name + "Response", response) },
      },
    };
  }
  for (const [path, request, kind, status] of [
    [
      "/funding-obligations/{id}/fee-revisions",
      feeRevisionProposalSchema,
      "propose",
      "200",
    ],
    [
      "/payment-fee-revisions/{id}/confirmations",
      feeRevisionConfirmationSchema,
      "confirm",
      "200",
    ],
    [
      "/payment-fee-revisions/{id}/payment-attempts",
      feeRevisionStartSchema,
      "start",
      "202",
    ],
  ]) {
    const op = spec.paths["/api/v1" + path]?.post ?? spec.paths[path]?.post;
    if (!op) throw Error("Undocumented fee revision " + path);
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: component("FeeRevision" + kind + "Request", request),
        },
      },
    };
    if (status === "202") delete op.responses["200"];
    op.responses[status] = {
      description:
        "Exact personally confirmed fee revision receipt and fresh current authority",
      content: {
        "application/json": {
          schema: component(
            "FeeRevision" + kind + "Response",
            feeRevisionResponses[kind],
          ),
        },
      },
    };
  }
  const cancellation =
    spec.paths["/api/v1/orders/{id}/cancellation"]?.post ??
    spec.paths["/orders/{id}/cancellation"]?.post;
  cancellation.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          oneOf: [
            { type: "object", properties: {}, additionalProperties: false },
            z.toJSONSchema(paymentCancellationSchema),
          ],
        },
      },
    },
  };
  for (const suffix of ["stripe", "stripe-thin"]) {
    const op =
      spec.paths["/api/v1/webhooks/" + suffix]?.post ??
      spec.paths["/webhooks/" + suffix]?.post;
    if (!op) throw Error("Webhook route missing");
    op.security = [];
    op.parameters = [
      {
        name: "stripe-signature",
        in: "header",
        required: true,
        schema: { type: "string" },
      },
    ];
    op.requestBody = {
      required: true,
      content: { "application/json": { schema: { type: "object" } } },
    };
    op.description =
      "Original raw bytes (maximum 262144) verified with the endpoint-specific Stripe signature secret before durable inbox insertion. Snapshot and thin parsers are separate. No browser cookie/Origin check. 400 invalid signature/scope; 503 unavailable runtime or durable persistence; 200 only after durable insertion or matching stored duplicate. Test signatures are not provider acceptance.";
    op.responses = {
      200: { description: "Durably stored or same stored duplicate" },
      400: { description: "Invalid signature or scope" },
      413: { description: "Bounded payload exceeded" },
      503: {
        description: "Runtime or persistence unavailable; retry delivery",
      },
    };
  }
}
