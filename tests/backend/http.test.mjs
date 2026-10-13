const teamBackground = {
  purpose: "Synthetic research",
  activities: "Read and discuss sources",
  timeCommitment: "One hour weekly",
  projectContext: "",
};
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import net from "node:net";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { hash, mac } from "../../backend/crypto.mjs";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMailWorker } from "../../backend/adapters/mail-worker.mjs";
const f = await fixture(),
  store = createStore(f.urls),
  mail = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  onData(stream, session, callback) {
    let s = "";
    stream.on("data", (d) => (s += d));
    stream.on("end", () => {
      mail.push(s);
      callback();
    });
  },
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const transport = nodemailer.createTransport({
  host: "127.0.0.1",
  port: smtp.server.address().port,
  ignoreTLS: true,
});
const worker = createMailWorker(store, {
  encryptionKey: f.config.encryptionKey,
  transport,
  from: "test@campus.example.test",
});
const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const logs = createWriteStream(
  new URL("../../.data/backend/http-test.log", import.meta.url),
);
const next = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      CAMPUS_BACKEND: "postgres",
      CAMPUS_DEMO: "0",
      CAMPUS_BUILD_DIR: ".next-backend-test",
      CAMPUS_ORIGIN: origin,
      CAMPUS_DB_APP: f.urls.app,
      CAMPUS_DB_AUTH: f.urls.auth,
      CAMPUS_DB_WORKER: f.urls.worker,
      CAMPUS_OTP_KEY: f.config.otpKey,
      CAMPUS_MAIL_KEY: f.config.encryptionKey,
      CAMPUS_SMTP_HOST: "127.0.0.1",
      CAMPUS_SMTP_PORT: String(smtp.server.address().port),
      CAMPUS_MAIL_FROM: "test@campus.example.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
next.stdout.pipe(logs);
next.stderr.pipe(logs);
test.after(async () => {
  next.kill("SIGTERM");
  if (next.exitCode === null)
    await Promise.race([
      new Promise((r) => next.once("exit", r)),
      new Promise((r) =>
        setTimeout(() => {
          next.kill("SIGKILL");
          r();
        }, 3000).unref(),
      ),
    ]);
  logs.end();
  transport.close();
  await new Promise((r) => smtp.close(r));
  await store.close();
  await f.close();
});
async function call(
  path,
  {
    method = "GET",
    body,
    cookie,
    originHeader = origin,
    key = randomUUID(),
  } = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Origin: originHeader,
      ...(cookie ? { Cookie: cookie } : {}),
      "Idempotency-Key": key,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    headers: response.headers,
    data: await response.json(),
  };
}
async function login(name) {
  const c = await call("/api/v1/auth/challenges", {
    method: "POST",
    body: { email: name.toLowerCase() + "@campus.example.test" },
  });
  assert.equal(c.status, 202);
  assert.equal("code" in c.data, false);
  await worker.tick();
  const code = mail.at(-1).match(/\b\d{6}\b/)[0];
  const r = await call("/api/v1/auth/sessions", {
    method: "POST",
    body: { challengeId: c.data.challengeId, code, displayName: name },
  });
  assert.equal(r.status, 200);
  assert.equal("token" in r.data, false);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  const user = r.data.user;
  await f.owner.query(
    "UPDATE campus.affiliations SET can_apply=true WHERE user_id=$1",
    [user.id],
  );
  return { id: user.id, cookie: r.headers.get("set-cookie").split(";")[0] };
}
const post = (path, user, body = {}) =>
  call("/api/v1/" + path, { method: "POST", cookie: user.cookie, body });
test("real Next HTTP: independent login, shared team research workflow, shipping privacy, auth and CSRF boundaries", async () => {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await call("/api/v1/health");
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    ready,
    true,
    "Next backend must start; see ignored .data/backend/http-test.log",
  );
  assert.equal(
    (
      await call("/api/auth", {
        method: "POST",
        body: { action: "quick", id: "professor" },
      })
    ).status,
    410,
  );
  assert.equal((await call("/api/v1/tasks")).status, 401);
  for (const email of [
    "student@gmail.com",
    "student@unreviewed.edu",
    "student@campus.example.test.evil.test",
  ]) {
    const rejected = await call("/api/v1/auth/challenges", {
      method: "POST",
      body: { email },
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.data.code, "unsupported_university_email");
    assert.equal(rejected.headers.get("set-cookie"), null);
    assert.equal("challengeId" in rejected.data, false);
  }
  assert.equal(
    (await f.owner.query("SELECT count(*)::int AS n FROM campus.challenges"))
      .rows[0].n,
    0,
  );
  assert.equal(
    (await f.owner.query("SELECT count(*)::int AS n FROM campus.mail_jobs"))
      .rows[0].n,
    0,
  );
  const alice = await login("Alice"),
    bob = await login("Bob"),
    chris = await login("Chris"),
    eve = await login("Eve");
  const team = await post("teams", bob, {
    name: "Field team",
    context: teamBackground,
  });
  assert.equal(team.status, 201);
  assert.equal(
    (
      await post(`teams/${team.data.id}/invitations`, bob, {
        userId: chris.id,
        expectedRevision: team.data.revision,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await post(`teams/${team.data.id}/membership`, chris, {
        expectedRevision: team.data.revision + 1,
      })
    ).status,
    200,
  );
  const task = await post("tasks", alice, {
    title: "Campus tree research",
    category: "Research",
    description: "Build a data set",
    rewardCents: 12000,
    milestones: [
      { title: "Survey", amountCents: 4000, deliverable: "Dataset" },
      { title: "Analysis", amountCents: 8000, deliverable: "Report" },
    ],
  });
  assert.equal(task.status, 201);
  const catalog = await call("/api/v1/tasks", { cookie: bob.cookie });
  assert.equal(catalog.data.items[0].id, task.data.id);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  const application = await post(`tasks/${task.data.id}/applications`, bob, {
    proposal: "Our team will deliver",
    teamId: team.data.id,
  });
  assert.equal(application.status, 201);
  assert.equal(
    (await post(`applications/${application.data.id}/invitation`, alice))
      .status,
    409,
  );
  assert.equal(
    (await post(`applications/${application.data.id}/consent`, chris)).status,
    200,
  );
  assert.equal(
    (await post(`applications/${application.data.id}/invitation`, alice))
      .status,
    200,
  );
  const agreement = await post(
    `applications/${application.data.id}/acceptance`,
    bob,
  );
  assert.equal(agreement.status, 200);
  assert.equal(agreement.data.state, "awaiting_funding");
  const teamView = await call(`/api/v1/agreements/${agreement.data.id}`, {
    cookie: chris.cookie,
  });
  assert.equal(teamView.data.milestones.length, 2);
  assert.equal(
    (
      await call(`/api/v1/agreements/${agreement.data.id}`, {
        cookie: eve.cookie,
      })
    ).status,
    404,
  );
  const p = await post("products", alice, {
    title: "Lab tools",
    description: "One set",
    priceCents: 2000,
    stock: 1,
    deliveryMethods: ["pickup", "shipping"],
    shippingCents: 500,
  });
  assert.equal(p.status, 201);
  const q = await post(`products/${p.data.id}/quotes`, bob, {
    quantity: 1,
    deliveryMethod: "shipping",
  });
  assert.equal(q.status, 201);
  const order = await post("orders", bob, {
    quoteId: q.data.id,
    shippingAddress: {
      name: "Bob",
      line1: "1 Campus Way",
      city: "Test",
      region: "CA",
      postalCode: "00000",
      country: "US",
    },
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.total_cents, 2500);
  assert.equal(
    (await call(`/api/v1/orders/${order.data.id}`, { cookie: eve.cookie }))
      .status,
    404,
  );
  const msg = await post("messages", bob, {
    orderId: order.data.id,
    body: "Please pack carefully.",
  });
  assert.equal(msg.status, 201);
  assert.equal(
    (
      await call(`/api/v1/messages?orderId=${order.data.id}`, {
        cookie: alice.cookie,
      })
    ).data.length,
    1,
  );
  assert.equal(
    (
      await call("/api/v1/teams", {
        method: "POST",
        cookie: bob.cookie,
        body: { name: "CSRF" },
        originHeader: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/v1/tasks?limit=1000", { cookie: bob.cookie })).status,
    422,
  );
  // Exercise every team lifecycle route with real cookies and current revisions.
  let lifecycle = (
    await post("teams", bob, {
      name: "Lifecycle over HTTP",
      context: teamBackground,
    })
  ).data;
  const lifecycleChange = async (path, user, extra = {}) => {
    const response = await post(`teams/${lifecycle.id}/${path}`, user, {
      expectedRevision: lifecycle.revision,
      ...extra,
    });
    assert.ok(
      [200, 201].includes(response.status),
      `${path}: ${response.data.code}`,
    );
    lifecycle = response.data;
    assert.ok(Array.isArray(lifecycle.members));
  };
  assert.equal(
    (await post(`teams/${lifecycle.id}/membership/decline`, chris)).status,
    422,
  );
  await lifecycleChange("context", bob, {
    context: { ...teamBackground, timeCommitment: "Two hours weekly" },
  });
  assert.equal(lifecycle.context.timeCommitment, "Two hours weekly");
  await lifecycleChange("invitations", bob, { userId: chris.id });
  await lifecycleChange("membership/decline", chris);
  assert.equal(lifecycle.owner_id, null);
  assert.equal(lifecycle.context, null);
  await lifecycleChange("invitations", bob, { userId: chris.id });
  await lifecycleChange(`members/${chris.id}/revoke`, bob);
  await lifecycleChange("invitations", bob, { userId: chris.id });
  await lifecycleChange("membership", chris);
  await lifecycleChange("invitations", bob, { userId: eve.id });
  await lifecycleChange("membership", eve);
  await lifecycleChange(`members/${eve.id}/remove`, bob);
  await lifecycleChange("captain", bob, { userId: chris.id });
  await lifecycleChange("membership/leave", bob);
  assert.equal(lifecycle.members.length, 1);
  assert.equal(lifecycle.own_state, "left");
  await lifecycleChange("archive", chris);
  assert.equal(lifecycle.status, "archived");
  // Exhaust only this fixture user's business bucket; auth/session uses real PG.
  await f.owner.query(
    "UPDATE campus.rate_limits SET hits=120,reset_at=now()+interval '15 minutes' WHERE bucket=$1",
    [mac(f.config.otpKey, "business:" + bob.id)],
  );
  assert.equal(
    (await post("teams", bob, { name: "Must be limited" })).status,
    429,
  );
  assert.equal((await call("/api/v1/me", { cookie: bob.cookie })).status, 200);
  assert.equal(
    (
      await call("/api/v1/auth/session", {
        method: "DELETE",
        body: {},
        cookie: bob.cookie,
        originHeader: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/v1/me", { cookie: bob.cookie })).status, 200);
  const logout = await call("/api/v1/auth/session", {
    method: "DELETE",
    body: {},
    cookie: bob.cookie,
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /campus_session=;.*Max-Age=0/);
  assert.ok(
    (
      await f.owner.query(
        "SELECT revoked_at FROM campus.sessions WHERE token_hash=$1",
        [hash(bob.cookie.slice("campus_session=".length))],
      )
    ).rows[0].revoked_at,
  );
  assert.equal((await call("/api/v1/me", { cookie: bob.cookie })).status, 401);
});
