import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, params, body, request }) =>
    runtime.market.openPaymentDispute(
      actor,
      "agreement",
      params.id,
      body,
      request.headers.get("idempotency-key"),
    ),
);
