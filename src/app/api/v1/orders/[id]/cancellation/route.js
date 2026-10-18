import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, params, body, request }) =>
    Object.keys(body).length
      ? runtime.market.cancelPaymentOrder(
          actor,
          params.id,
          body,
          request.headers.get("idempotency-key"),
        )
      : runtime.market.cancelOrder(
          actor,
          params.id,
          body,
          request.headers.get("idempotency-key"),
        ),
);
