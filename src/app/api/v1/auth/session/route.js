import { api } from "@/lib/backend.mjs";
import { sessionCookie } from "../../../../../../backend/http/endpoint.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const DELETE = api(
  // Session revocation must remain available after business writes are limited.
  { method: "DELETE", businessRateLimit: false },
  async ({ runtime, token }) => {
    await runtime.auth.logout(token);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie(runtime.config, "", 0) } },
    );
  },
);
