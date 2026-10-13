import { NextRequest, NextResponse } from "next/server";
import { requestStore, checkLocal, userId, failure, input } from "@/lib/server";
export async function POST(request: NextRequest) {
  try {
    if (process.env.CAMPUS_BACKEND === "postgres")
      return NextResponse.json(
        { error: "Use /api/v1 for the shared backend." },
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    checkLocal(request, true);
    const { action, ...data } = await input(request);
    const { store } = requestStore(request);
    if (!store)
      throw Object.assign(
        new Error("Sign in to start your private demo workspace."),
        { status: 401 },
      );
    const result = store.command(userId(request, store), action, data);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return failure(e);
  }
}
