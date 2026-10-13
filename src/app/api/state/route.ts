import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  requestStore,
  isPublicPreview,
  checkLocal,
  userId,
  failure,
} from "@/lib/server";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  try {
    if (process.env.CAMPUS_BACKEND === "postgres")
      return NextResponse.json(
        { error: "Use /api/v1 for the shared backend." },
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    checkLocal(request);
    const { store } = requestStore(request);
    return NextResponse.json(
      {
        ...(store || getStore()).state(userId(request, store)),
        preview: isPublicPreview(),
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
