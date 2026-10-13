import { api } from "@/lib/backend.mjs";
import { conversationHttpQuery } from "../../../../../../backend/modules/conversations.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api({ method: "GET" }, async ({ runtime, actor, request }) =>
  runtime.market.conversationParticipants(
    actor,
    conversationHttpQuery(request),
  ),
);
