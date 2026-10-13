import { api } from "@/lib/backend.mjs";
import { conversationHttpQuery } from "../../../../../backend/modules/conversations.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET" },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.messages(actor, conversationHttpQuery(request));
  },
);
export const POST = api(
  { method: "POST", status: 201 },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    return runtime.market.sendMessage(actor, body, key);
  },
);
