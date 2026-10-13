import test from "node:test";
import assert from "node:assert/strict";
import { endpoint } from "../../backend/http/endpoint.mjs";
const runtime = {
  config: {
    origin: "https://campus.example.test",
    cookieName: "__Host-campus_session",
    production: true,
  },
  auth: {
    async resolve(t) {
      assert.equal(t, "valid");
      return { id: "actor" };
    },
    async limitBusiness() {},
  },
};
const req = (headers = {}, body = "{}") =>
  new Request("https://campus.example.test/api/v1/tasks", {
    method: "POST",
    headers: {
      host: "campus.example.test",
      origin: "https://campus.example.test",
      "content-type": "application/json",
      cookie: "__Host-campus_session=valid",
      ...headers,
    },
    body,
  });
test("HTTP boundary protects origin/host, body size and returns no-store problem details without secrets", async () => {
  const handler = endpoint(
    async () => runtime,
    { method: "POST" },
    async ({ actor, body }) => ({ actor, body }),
  );
  const good = await handler(req(), {});
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal((await good.json()).actor, "actor");
  assert.equal(
    (await handler(req({ origin: "https://evil.test" }), {})).status,
    403,
  );
  assert.equal((await handler(req({ host: "evil.test" }), {})).status, 403);
  assert.equal(
    (await handler(req({ "content-type": "text/plain" }), {})).status,
    415,
  );
  assert.equal((await handler(req({}, "{bad"), {})).status, 400);
  assert.equal(
    (await handler(req({}, JSON.stringify({ text: "x".repeat(70000) })), {}))
      .status,
    413,
  );
  const crash = endpoint(
    async () => runtime,
    { method: "POST" },
    async () => {
      throw Error("password=secret schema=campus");
    },
  );
  const result = await crash(req(), {}),
    problem = await result.json();
  assert.equal(result.status, 500);
  assert.equal(result.headers.get("content-type"), "application/problem+json");
  assert.equal(problem.detail.includes("secret"), false);
  assert.ok(problem.requestId);
});
