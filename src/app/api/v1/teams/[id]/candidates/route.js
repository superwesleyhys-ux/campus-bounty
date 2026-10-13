import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api({ method: "GET" }, ({ runtime, actor, params, query }) =>
  runtime.market.teamCandidate(actor, params.id, query),
);
