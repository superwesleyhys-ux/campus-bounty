import { api } from "@/lib/backend.mjs";
import { requireThat } from "../../../../../backend/errors.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET" },
  async ({ runtime, actor, query, request }) => {
    const keys = [...new URL(request.url).searchParams.keys()];
    requireThat(
      new Set(keys).size === keys.length,
      422,
      "invalid_input",
      "Query fields must not be repeated.",
    );
    return runtime.market.notifications(actor, query);
  },
);
