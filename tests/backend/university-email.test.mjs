import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createAuth } from "../../backend/modules/auth.mjs";
import { universityForEmail } from "../../src/lib/university-email.mjs";

test("university gate rejects personal, unreviewed and lookalike domains without auth side effects", async (t) => {
  const f = await fixture(),
    store = createStore(f.urls),
    auth = createAuth(store, f.config);
  t.after(async () => {
    await store.close();
    await f.close();
  });
  const directory = [
    { name: "Test University", domain: "campus.example.test" },
  ];
  for (const email of [
    "student@gmail.com",
    "student@outlook.com",
    "student@qq.com",
    "student@unreviewed.edu",
    "student@college.ac.uk",
    "student@campus.example.test.evil.test",
    "student@evilcampus.example.test",
    "student@department.campus.example.test",
  ]) {
    assert.equal(universityForEmail(email, directory), undefined);
    await assert.rejects(
      auth.request({ email }, randomUUID()),
      (e) => e.status === 422 && e.code === "unsupported_university_email",
    );
  }
  for (const email of [
    "student@@campus.example.test",
    "student@campus.example.test\r\nBcc:other@example.test",
    "student@campus.example.test.",
  ])
    await assert.rejects(
      auth.request({ email }, randomUUID()),
      (e) => e.code === "invalid_input",
    );
  const counts = (
    await f.owner.query(`SELECT
    (SELECT count(*)::int FROM campus.challenges) AS challenges,
    (SELECT count(*)::int FROM campus.mail_jobs) AS mail,
    (SELECT count(*)::int FROM campus.users) AS users,
    (SELECT count(*)::int FROM campus.sessions) AS sessions`)
  ).rows[0];
  assert.deepEqual(counts, { challenges: 0, mail: 0, users: 0, sessions: 0 });
});

test("university gate normalizes approved domains, requires explicit subdomain approval and observes revocation", async (t) => {
  const f = await fixture(),
    store = createStore(f.urls),
    auth = createAuth(store, f.config);
  t.after(async () => {
    await store.close();
    await f.close();
  });
  const email = "  Student+Lab@CAMPUS.EXAMPLE.TEST  ";
  assert.equal(
    universityForEmail(email, [{ name: "Test", domain: "campus.example.test" }])
      .name,
    "Test",
  );
  const challenge = await auth.request({ email }, randomUUID());
  assert.ok(challenge.challengeId);
  assert.equal(
    (
      await f.owner.query("SELECT email FROM campus.challenges WHERE id=$1", [
        challenge.challengeId,
      ])
    ).rows[0].email,
    "student+lab@campus.example.test",
  );
  await f.owner.query(
    "INSERT INTO campus.domains(domain,institution_id,enabled) VALUES('department.campus.example.test',$1,true)",
    [f.institution],
  );
  assert.ok(
    (
      await auth.request(
        { email: "student@department.campus.example.test" },
        randomUUID(),
      )
    ).challengeId,
  );
  await f.owner.query(
    "UPDATE campus.domains SET enabled=false WHERE domain='campus.example.test'",
  );
  await assert.rejects(
    auth.request({ email: "next@campus.example.test" }, randomUUID()),
    (e) => e.code === "unsupported_university_email",
  );
  await f.owner.query("UPDATE campus.institutions SET active=false");
  await assert.rejects(
    auth.request(
      { email: "next@department.campus.example.test" },
      randomUUID(),
    ),
    (e) => e.code === "unsupported_university_email",
  );
  assert.equal(
    (await f.owner.query("SELECT count(*)::int AS n FROM campus.mail_jobs"))
      .rows[0].n,
    2,
  );
});
