import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api({ method: "GET" }, async ({ runtime, actor, query }) =>
  runtime.market.myEligibilityRequests(actor, query),
);
export const POST = api(
  { method: "POST", status: 201 },
  async ({ runtime, actor, body, request }) =>
    runtime.market.requestEligibility(
      actor,
      body,
      request.headers.get("idempotency-key"),
    ),
);
