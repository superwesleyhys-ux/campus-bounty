import { api } from "@/lib/backend.mjs";
import { previewAvailable } from "../../../../../../backend/modules/preview-entry.mjs";
import { Problem } from "../../../../../../backend/errors.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = api(
  { method: "POST", public: true, status: 202 },
  async ({ runtime, actor, body, params, query, request, token, ip }) => {
    const key = request.headers.get("idempotency-key");
    if (
      typeof body?.email === "string" &&
      !body.email.trim().toLowerCase().endsWith("@campus.example.test") &&
      (await previewAvailable(runtime))
    )
      throw new Problem(
        503,
        "preview_email_unavailable",
        "Real email delivery is unavailable in this local preview. Use a clearly labeled sample account; your real email will not be converted to a sample identity.",
      );
    return runtime.auth.request(body, ip);
  },
);
