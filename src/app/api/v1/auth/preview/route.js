import { api } from "@/lib/backend.mjs";
import {
  enterPreview,
  previewAvailable,
} from "../../../../../../backend/modules/preview-entry.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = api(
  { method: "GET", public: true },
  async ({ runtime }) => ({ enabled: await previewAvailable(runtime) }),
);
export const POST = api({ method: "POST", public: true }, enterPreview);
