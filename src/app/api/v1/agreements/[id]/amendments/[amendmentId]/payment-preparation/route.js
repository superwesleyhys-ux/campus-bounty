import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, params, body, request }) => {
    await runtime.market.agreementAmendment(
      actor,
      params.id,
      params.amendmentId,
    );
    return runtime.market.preparePaymentTerms(
      actor,
      "amendment",
      params.amendmentId,
      body,
      request.headers.get("idempotency-key"),
    );
  },
);
