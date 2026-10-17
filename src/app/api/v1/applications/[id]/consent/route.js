import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.acknowledgeApplicationTerms(
      actor,
      params.id,
      body,
      key,
    );
  },
);
