import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export function GET() {
  if (process.env.CAMPUS_BACKEND === "postgres")
    return NextResponse.json(
      { error: "Use /api/v1/health for shared backend readiness." },
      { status: 410 },
    );
  return NextResponse.json(
    {
      status: "ok",
      service: "campus-bounty",
      mode: process.env.CAMPUS_PUBLIC_ORIGIN ? "cloud-preview" : "local-demo",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
