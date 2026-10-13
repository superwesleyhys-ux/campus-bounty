import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.saveTask(actor, params.id, body, key);
  },
);
export const DELETE = api(
  { method: "DELETE" },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.unsaveTask(actor, params.id, body, key);
  },
);
