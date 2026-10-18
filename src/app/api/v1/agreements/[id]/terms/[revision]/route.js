import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET", status: 200 },
  async ({ runtime, actor, params, query, body, request }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.agreementTermsRevision(
      actor,
      params.id,
      params.revision,
    );
  },
);
