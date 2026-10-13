import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET", public: true },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return (
      await runtime.store.auth.query(
        "SELECT i.id,i.name,d.domain FROM campus.institutions i JOIN campus.domains d ON d.institution_id=i.id WHERE i.active AND d.enabled ORDER BY i.name,d.domain",
      )
    ).rows;
  },
);
