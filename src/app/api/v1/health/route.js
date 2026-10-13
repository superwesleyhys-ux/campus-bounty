import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET", public: true },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    await runtime.store.app.query("SELECT 1");
    return {
      service: "campus-bounty-backend",
      database: "ready",
      payments: "not_configured",
    };
  },
);
