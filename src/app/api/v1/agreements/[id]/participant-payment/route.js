import { api } from "@/lib/backend.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api({ method: "GET" }, async ({ runtime, actor, params }) =>
  runtime.market.participantPayment(actor, "agreement", params.id),
);
