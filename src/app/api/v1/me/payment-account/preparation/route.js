import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, body, request }) =>
    runtime.market.preparePaymentRecipient(
      actor,
      body,
      request.headers.get("idempotency-key"),
    ),
);
