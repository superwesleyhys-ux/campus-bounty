import { NextRequest, NextResponse } from "next/server";
import { validateAuthStart } from "@/lib/preview.mjs";
import {
  requestStore,
  isPublicPreview,
  workspaceCookie,
  checkLocal,
  failure,
  input,
} from "@/lib/server";
export async function POST(request: NextRequest) {
  try {
    if (process.env.CAMPUS_BACKEND === "postgres")
      return NextResponse.json(
        { error: "Use /api/v1 for the shared backend." },
        { status: 410, headers: { "Cache-Control": "no-store" } },
      );
    checkLocal(request, true);
    const data = await input(request);
    if (!["request", "quick", "verify", "logout"].includes(data.action))
      throw Object.assign(new Error("Invalid action."), { status: 422 });
    validateAuthStart(data);
    const { store, id } = requestStore(
      request,
      ["request", "quick"].includes(data.action),
    );
    const mode = isPublicPreview() ? "cloud-preview" : "local-demo";
    const setWorkspace = (response: NextResponse) => {
      if (id && isPublicPreview())
        response.cookies.set(workspaceCookie, id, {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: "/",
          maxAge: 604800,
        });
      return response;
    };
    if (!store)
      throw Object.assign(new Error("Refresh the page and sign in again."), {
        status: 401,
      });
    if (data.action === "request")
      return setWorkspace(
        NextResponse.json({
          ...store.requestCode(data.email),
          mode,
          emailSent: false,
        }),
      );
    let token = "";
    if (data.action === "quick") token = store.quickSession(data.id);
    else if (data.action === "verify")
      token = store.verifyCode(data.challengeId, String(data.code));
    else if (data.action === "logout")
      store.logout(request.cookies.get("campus_session")?.value);
    else throw Object.assign(new Error("Invalid action."), { status: 422 });
    if (token) store.logout(request.cookies.get("campus_session")?.value);
    const response = setWorkspace(NextResponse.json({ ok: true, mode }));
    response.cookies.set("campus_session", token, {
      httpOnly: true,
      secure: isPublicPreview(),
      sameSite: "strict",
      path: "/",
      maxAge: token ? 43200 : 0,
    });
    return response;
  } catch (e) {
    return failure(e);
  }
}
