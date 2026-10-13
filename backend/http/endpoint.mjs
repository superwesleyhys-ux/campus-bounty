import { randomUUID } from "node:crypto";
import { Problem, requireThat } from "../errors.mjs";
export function cookieValue(request, name) {
  const entry = request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="));
  return entry ? entry.slice(name.length + 1) : undefined;
}
export function sessionCookie(config, token, maxAge = 604800) {
  return `${config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.production ? "; Secure" : ""}`;
}
async function input(request) {
  requireThat(
    request.headers.get("content-type")?.split(";")[0].trim() ===
      "application/json",
    415,
    "unsupported_media_type",
    "Use application/json.",
  );
  requireThat(
    Number(request.headers.get("content-length") || 0) <= 65536,
    413,
    "body_too_large",
    "The request exceeds 64 KiB.",
  );
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new Problem(
            413,
            "body_too_large",
            "The request exceeds 64 KiB.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Problem(
      400,
      "invalid_json",
      "The request body must be valid JSON.",
    );
  }
}
export function endpoint(getRuntime, options, run) {
  return async (request, context = {}) => {
    const requestId = randomUUID();
    let response;
    try {
      const runtime = await getRuntime(),
        config = runtime.config;
      requireThat(
        request.method === options.method,
        405,
        "method_not_allowed",
        "This method is not supported.",
      );
      const expected = new URL(config.origin);
      requireThat(
        request.headers.get("host") === expected.host,
        403,
        "invalid_host",
        "The request host is not allowed.",
      );
      const write = !["GET", "HEAD"].includes(request.method);
      if (write)
        requireThat(
          request.headers.get("origin") === config.origin,
          403,
          "invalid_origin",
          "The request origin is not allowed.",
        );
      const token = cookieValue(request, config.cookieName);
      const user = options.public ? null : await runtime.auth.resolve(token);
      if (write && user && options.businessRateLimit !== false)
        await runtime.auth.limitBusiness(user.id);
      const body = write ? await input(request) : undefined;
      // Without a trusted ingress, use a conservative shared bucket rather than trust client-spoofed IP headers.
      const ip =
        config.proxySecret &&
        request.headers.get("x-campus-proxy-secret") === config.proxySecret
          ? request.headers.get("x-real-ip") || "ingress"
          : "shared-ingress";
      const result = await run({
        runtime,
        request,
        params: (await context.params) || {},
        query: Object.fromEntries(new URL(request.url).searchParams),
        body,
        actor: user?.id,
        user,
        token,
        ip,
      });
      response =
        result instanceof Response
          ? result
          : Response.json(result, { status: options.status || 200 });
    } catch (error) {
      const conflict = [
        "23505",
        "23514",
        "23503",
        "40001",
        "40P01",
        "55P03",
      ].includes(error?.code);
      const status =
        error instanceof Problem ? error.status : conflict ? 409 : 500;
      const code =
        error instanceof Problem
          ? error.code
          : conflict
            ? "state_conflict"
            : "internal_error";
      const detail =
        error instanceof Problem
          ? error.message
          : conflict
            ? "The resource changed or conflicts with this request. Reload and try again."
            : "The request could not be completed.";
      if (status === 500)
        console.error(
          JSON.stringify({ event: "campus.request_failed", requestId, code }),
        );
      response = new Response(
        JSON.stringify({
          type: `urn:campus-bounty:problem:${code}`,
          title: code.replaceAll("_", " "),
          status,
          code,
          detail,
          requestId,
        }),
        {
          status,
          headers: {
            "Content-Type": "application/problem+json",
            ...(status === 429 ? { "Retry-After": "900" } : {}),
          },
        },
      );
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Request-Id", requestId);
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  };
}
