import { api } from "@/lib/backend.mjs";
import { conversationHttpQuery } from "../../../../../../backend/modules/conversations.mjs";
export const runtime = "nodejs";
export const GET = api({ method: "GET" }, ({ runtime, actor, request }) =>
  runtime.market.conversationInbox(actor, conversationHttpQuery(request)),
);
