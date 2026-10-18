import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET" },
  async ({ runtime, actor, params, query }) =>
    runtime.market.applicationAllocation(actor, params.id, query),
);
export const POST = api(
  { method: "POST" },
  async ({ runtime, actor, params, body, request }) =>
    runtime.market.proposeAllocation(
      actor,
      params.id,
      body,
      request.headers.get("idempotency-key"),
    ),
);
