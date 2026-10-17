import { api } from "@/lib/backend.mjs";
import { historyHttpQuery } from "../../../../../../backend/modules/workspace-history.mjs";
export const runtime = "nodejs";
export const GET = api({ method: "GET" }, ({ runtime, actor, request }) =>
  runtime.market.workspaceHistory(actor, historyHttpQuery(request)),
);
