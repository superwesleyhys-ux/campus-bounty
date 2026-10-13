import { api } from "@/lib/backend.mjs";
import { sessionCookie } from "../../../../../../backend/http/endpoint.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST", public: true },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    const result = await runtime.auth.verify(body, ip);
    if (token) await runtime.auth.logout(token);
    return Response.json(
      { user: result.user },
      {
        headers: { "Set-Cookie": sessionCookie(runtime.config, result.token) },
      },
    );
  },
);
