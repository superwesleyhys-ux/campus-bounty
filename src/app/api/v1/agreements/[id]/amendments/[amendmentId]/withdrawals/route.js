import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST", status: 200 },
  async ({ runtime, actor, params, query, body, request }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.withdrawAmendment(
      actor,
      params.id,
      params.amendmentId,
      body,
      key,
    );
  },
);
