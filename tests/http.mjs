import assert from "node:assert/strict";
import http from "node:http";

// Run against an isolated demo database; this test creates a local session.
const origin = process.env.CAMPUS_TEST_ORIGIN || "http://127.0.0.1:3011";
const post = (path, body, headers = {}) =>
  fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
assert.equal(
  (await post("/api/action", { action: "save", id: "bounty-1" })).status,
  401,
);
assert.equal(
  (
    await post(
      "/api/auth",
      { action: "quick", id: "student" },
      { Origin: "https://example.com" },
    )
  ).status,
  403,
);
// fetch may normalize Host; use a raw HTTP request to exercise this boundary.
const foreignHostStatus = await new Promise((resolve, reject) => {
  const request = http.get(
    origin + "/api/state",
    { headers: { Host: "example.com" } },
    (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    },
  );
  request.on("error", reject);
});
assert.equal(foreignHostStatus, 403);
const guest = await (await fetch(origin + "/api/state")).json();
assert.equal(guest.user, null);
assert.equal(guest.orders.length, 0);
assert.ok(guest.users.every((u) => !Object.hasOwn(u, "email")));
assert.ok(
  guest.tasks.every(
    (t) =>
      !t.applications.length && !t.messages.length && !t.submissions.length,
  ),
);
const auth = await post("/api/auth", { action: "quick", id: "student" });
assert.equal(auth.status, 200);
const setCookie = auth.headers.get("set-cookie");
assert.match(setCookie, /HttpOnly/i);
assert.match(setCookie, /SameSite=Strict/i);
const Cookie = setCookie.split(";")[0];
const member = await (
  await fetch(origin + "/api/state", { headers: { Cookie } })
).json();
assert.equal(member.user.id, "student");
assert.equal(
  (await post("/api/auth", { action: "logout" }, { Cookie })).status,
  200,
);
assert.equal(
  (await post("/api/action", { action: "save", id: "bounty-1" }, { Cookie }))
    .status,
  401,
);
console.log(
  "HTTP auth, origin, host, guest privacy, cookie attributes and logout revocation PASS",
);
