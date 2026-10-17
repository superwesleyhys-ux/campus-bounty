import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET" },
  async ({ runtime, actor, params, body, query, request }) =>
    runtime.market.listingHistory(actor, "product", params.id, {
      ...query,
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.beforeVersion
        ? { beforeVersion: Number(query.beforeVersion) }
        : {}),
    }),
);
