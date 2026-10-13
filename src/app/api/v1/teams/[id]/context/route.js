import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, body, params, request }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.updateTeamContext(actor, params.id, body, key);
  },
);
