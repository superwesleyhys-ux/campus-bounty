import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST", status: 201 },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.quoteVersioned(actor, params.id, body, key);
  },
);
