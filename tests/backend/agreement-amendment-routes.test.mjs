// Real route source + real shared HTTP boundary, with a mocked auth/market transport.
// No HTTP server, browser, live session, or provider is used.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { endpoint } from "../../backend/http/endpoint.mjs";
import { Problem } from "../../backend/errors.mjs";
const actor = "d0567a53-4273-43d1-8f50-814f5f3ec416",
  id = "cdd3c46a-6141-4313-9f44-559aaefbe43d",
  amendmentId = "f74b4d6a-ec3b-42ee-9451-bfdf652bf486";
const calls = [];
let rateLimit = false;
const runtime = {
  config: {
    origin: "https://campus.example.test",
    cookieName: "__Host-campus_session",
  },
  auth: {
    async resolve(token) {
      if (token !== "synthetic")
        throw new Problem(401, "unauthorized", "Sign in.");
      return { id: actor };
    },
    async limitBusiness() {
      if (rateLimit) throw new Problem(429, "rate_limited", "Try later.");
    },
  },
  market: new Proxy(
    {},
    {
      get:
        (_, method) =>
        (...args) => {
          calls.push({ method, args });
          return { method, args };
        },
    },
  ),
};
const binding = Symbol.for("campus.r13.route.transport");
globalThis[binding] = (options, run) =>
  endpoint(async () => runtime, options, run);
async function load(route) {
  const file = new URL(
    "../../src/app/api/v1/" + route + "/route.js",
    import.meta.url,
  );
  let source = await readFile(file, "utf8");
  source = source
    .replace(
      'import { api } from "@/lib/backend.mjs";',
      'const api=globalThis[Symbol.for("campus.r13.route.transport")];',
    )
    .replace(
      /from "(\.[^"]+)"/g,
      (_, target) => 'from "' + new URL(target, file).href + '"',
    );
  return import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
}
function request(path, method = "GET", body = {}, headers = {}) {
  return new Request("https://campus.example.test/api/v1/" + path, {
    method,
    headers: {
      host: "campus.example.test",
      origin: "https://campus.example.test",
      cookie: "__Host-campus_session=synthetic",
      "content-type": "application/json",
      "idempotency-key": "synthetic-r13-key",
      ...headers,
    },
    ...(method === "POST"
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}
const params = { id, amendmentId, revision: "1" };
test("all resource routes dispatch authenticated actor, resource identity, exact body/key and promised params", async () => {
  const routes = [
    ["capabilities", "GET", "capabilities", []],
    ["agreements/[id]/terms", "GET", "agreementTerms", [id, {}]],
    [
      "agreements/[id]/terms/[revision]",
      "GET",
      "agreementTermsRevision",
      [id, "1"],
    ],
    ["agreements/[id]/amendments", "GET", "agreementAmendments", [id, {}]],
    [
      "agreements/[id]/amendments",
      "POST",
      "proposeAmendment",
      [id, {}, "synthetic-r13-key"],
    ],
    [
      "agreements/[id]/amendments/[amendmentId]",
      "GET",
      "agreementAmendment",
      [id, amendmentId, {}],
    ],
    [
      "agreements/[id]/amendments/[amendmentId]/events",
      "GET",
      "amendmentEvents",
      [id, amendmentId, {}],
    ],
    ...["revisions", "confirmations", "rejections", "withdrawals"].map(
      (route, i) => [
        "agreements/[id]/amendments/[amendmentId]/" + route,
        "POST",
        [
          "reviseAmendment",
          "confirmAmendment",
          "rejectAmendment",
          "withdrawAmendment",
        ][i],
        [id, amendmentId, {}, "synthetic-r13-key"],
      ],
    ),
  ];
  for (const [route, verb, method, args] of routes) {
    const handler = (await load(route))[verb];
    const response = await handler(request(route, verb), {
      params: Promise.resolve(params),
    });
    assert.equal(
      response.status,
      route === "agreements/[id]/amendments" && verb === "POST" ? 201 : 200,
    );
    assert.deepEqual(await response.json(), { method, args: [actor, ...args] });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("new routes retain host origin session JSON size and rate gates; repeated query is rejected", async () => {
  const route = await load("agreements/[id]/amendments");
  for (const [headers, body, status] of [
    [{ host: "other.example.test" }, {}, 403],
    [{ origin: "https://other.example.test" }, {}, 403],
    [{ cookie: "" }, {}, 401],
    [{ "content-type": "text/plain" }, {}, 415],
    [{}, "{bad", 400],
    [{}, JSON.stringify({ content: "x".repeat(70000) }), 413],
  ]) {
    const before = calls.length;
    assert.equal(
      (
        await route.POST(
          request("agreements/" + id + "/amendments", "POST", body, headers),
          { params },
        )
      ).status,
      status,
    );
    assert.equal(calls.length, before);
  }
  rateLimit = true;
  assert.equal(
    (
      await route.POST(request("agreements/" + id + "/amendments", "POST"), {
        params,
      })
    ).status,
    429,
  );
  rateLimit = false;
  const response = await route.GET(
    request("agreements/" + id + "/amendments?limit=1&limit=2"),
    { params },
  );
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "invalid_input");
});
