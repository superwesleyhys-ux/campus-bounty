import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { checkRequest, createPreviewPool } from "./preview.mjs";
import { readInput } from "./request-body.mjs";
export const workspaceCookie = "__Host-campus_preview";
export const isPublicPreview = () => Boolean(process.env.CAMPUS_PUBLIC_ORIGIN);
let previewPool: ReturnType<typeof createPreviewPool> | undefined;
let instance: ReturnType<typeof createStore> | undefined;
export function getStore() {
  // Build workers import route modules; only live requests should open a DB.
  return (instance ??= createStore(
    process.env.CAMPUS_DB || join(process.cwd(), ".data", "campus.db"),
  ));
}
export function checkLocal(request: NextRequest, write = false) {
  checkRequest(
    request.headers,
    {
      enabled: process.env.CAMPUS_DEMO,
      publicOrigin: process.env.CAMPUS_PUBLIC_ORIGIN,
    },
    write,
  );
}
export function requestStore(request: NextRequest, create = false) {
  if (!isPublicPreview())
    return { store: getStore(), id: undefined as string | undefined };
  previewPool ??= createPreviewPool(
    process.env.CAMPUS_DATA_DIR || join(process.cwd(), ".data", "preview"),
  );
  const id = request.cookies.get(workspaceCookie)?.value;
  const store = previewPool.get(id);
  if (store) return { store, id };
  if (create) return previewPool.create();
  return { store: null, id: undefined as string | undefined };
}
export function userId(
  request: NextRequest,
  store: ReturnType<typeof createStore> | null,
) {
  return (
    store?.sessionUser(request.cookies.get("campus_session")?.value) || null
  );
}
export function failure(e: unknown) {
  const error = e as { message?: string; status?: number; code?: string };
  if (!error.status && !error.code)
    console.error("Local demo request failed:", error.message);
  return NextResponse.json(
    {
      error:
        error.status || error.code
          ? error.message
          : "Request failed. Please try again.",
      code: error.code || "REQUEST_FAILED",
    },
    { status: error.status || (error.code ? 422 : 500) },
  );
}
export async function input(request: NextRequest) {
  return readInput(request);
}
