import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore, account, member } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";

const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
const reviewer = await f.user("Reviewer", false),
  reviewer2 = await f.user("Other reviewer", false);
const stranger = await f.user("Stranger", false),
  legacy = await f.user("Legacy student");
await f.owner.query(
  "INSERT INTO campus.eligibility_reviewers VALUES($1,$3),($2,$3)",
  [reviewer, reviewer2, f.institution],
);
const key = () => randomUUID();
const expires = (days = 30) =>
  new Date(Date.now() + days * 86400000).toISOString();
const submission = {
  enrollmentSummary: "Currently enrolled in the engineering program.",
  attestation: true,
};
const approve = (validUntil = expires()) => ({
  decision: "approved",
  reason: "Current enrollment reviewed.",
  validUntil,
});
const reject = {
  decision: "rejected",
  reason: "Please explain your current enrollment more clearly.",
};
const fresh = async (name = "Applicant") => {
  const user = await f.user(name, false);
  return {
    user,
    request: await market.requestEligibility(user, submission, key()),
  };
};
test.after(async () => {
  await store.close();
  await f.close();
});

test("self profile is editable, validated, private, idempotent, and cannot grant account authority", async () => {
  const user = await f.user("Original", false),
    k = key(),
    input = { displayName: "  Riley  ", bio: "  Materials researcher.  " };
  const changed = await market.updateProfile(user, input, k);
  assert.equal(changed.display_name, "Riley");
  assert.equal(changed.bio, "Materials researcher.");
  assert.equal(changed.institution_name, "Test University");
  assert.equal(changed.can_apply, false);
  assert.equal(changed.can_review_eligibility, false);
  assert.equal("email" in changed, false);
  assert.deepEqual(await market.updateProfile(user, input, k), changed);
  await assert.rejects(
    market.updateProfile(user, { ...input, bio: "Different" }, k),
    { code: "idempotency_conflict" },
  );
  for (const invalid of [
    { displayName: " ", bio: "" },
    { displayName: "A", bio: "x".repeat(501) },
    { displayName: "A", bio: "", accountStatus: "active" },
    { displayName: "A", bio: "", canApply: true },
  ])
    await assert.rejects(market.updateProfile(user, invalid, key()), {
      status: 422,
    });
  await assert.rejects(
    store.as(user, (c) =>
      c.query("UPDATE campus.users SET account_status='active' WHERE id=$1", [
        user,
      ]),
    ),
    { code: "42501" },
  );
  assert.equal(
    (
      await store.as(stranger, (c) =>
        c.query("UPDATE campus.users SET bio='stolen' WHERE id=$1", [user]),
      )
    ).rowCount,
    0,
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
    [user],
  );
  assert.equal(
    (
      await market.updateProfile(
        user,
        { displayName: "Riley", bio: "Still my profile" },
        key(),
      )
    ).bio,
    "Still my profile",
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='locked' WHERE id=$1",
    [user],
  );
  await assert.rejects(
    market.updateProfile(user, { displayName: "Riley", bio: "" }, key()),
    { code: "account_locked" },
  );
});

test("student request requires attestation and current active membership, does not auto-approve, and has one pending row", async () => {
  const user = await f.user("Request user", false),
    k = key();
  for (const input of [
    { ...submission, attestation: false },
    { ...submission, enrollmentSummary: " " },
    { ...submission, institutionId: f.institution },
    { ...submission, enrollmentSummary: "x".repeat(1001) },
  ])
    await assert.rejects(market.requestEligibility(user, input, key()), {
      code: "invalid_input",
    });
  const request = await market.requestEligibility(user, submission, k);
  assert.equal(request.status, "pending");
  assert.equal(request.institution_id, f.institution);
  assert.equal(request.membership_current, true);
  assert.equal(request.can_review, false);
  for (const forbidden of ["email", "domain", "reviewer_id"])
    assert.equal(forbidden in request, false);
  assert.deepEqual(
    await market.requestEligibility(user, submission, k),
    request,
  );
  await assert.rejects(market.requestEligibility(user, submission, key()), {
    code: "eligibility_pending",
  });
  assert.equal((await market.me(user)).can_apply, false);
  const raceUser = await f.user("Concurrent applicant", false);
  const race = await Promise.allSettled([
    market.requestEligibility(raceUser, submission, key()),
    market.requestEligibility(raceUser, submission, key()),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    race.find((x) => x.status === "rejected").reason.code,
    "eligibility_pending",
  );
  for (const condition of ["expired", "restricted"]) {
    const id = await f.user(condition, false);
    if (condition === "expired")
      await f.owner.query(
        "UPDATE campus.affiliations SET valid_until=now()-interval '1 day' WHERE user_id=$1",
        [id],
      );
    else
      await f.owner.query(
        "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
        [id],
      );
    await assert.rejects(market.requestEligibility(id, submission, key()), {
      code: "membership_required",
    });
  }
  await assert.rejects(market.requestEligibility(legacy, submission, key()), {
    code: "eligibility_current",
  });
});

test("reviewer grants and request decisions cannot be forged through application or auth roles", async () => {
  const { user, request } = await fresh();
  for (const sql of [
    "INSERT INTO campus.eligibility_reviewers VALUES($1,$2)",
    "UPDATE campus.eligibility_requests SET status='approved' WHERE user_id=$1",
    "DELETE FROM campus.eligibility_requests WHERE user_id=$1",
  ]) {
    const values = sql.startsWith("INSERT") ? [user, f.institution] : [user];
    await assert.rejects(
      store.as(user, (c) => c.query(sql, values)),
      { code: "42501" },
    );
  }
  for (const role of [store.app, store.auth, store.worker])
    await assert.rejects(
      role.query("SELECT * FROM campus.eligibility_reviewers"),
      { code: "42501" },
    );
  for (const role of [store.app, store.auth])
    await assert.rejects(
      role.query(
        "UPDATE campus.affiliations SET can_apply=true,student_valid_until=now()+interval '1 year' WHERE user_id=$1",
        [user],
      ),
      { code: "42501" },
    );
  await assert.rejects(
    store.as(user, (c) =>
      c.query(
        "SELECT campus.decide_student_eligibility($1,'approved','Forged',now()+interval '1 day')",
        [request.id],
      ),
    ),
    { code: "42501" },
  );
  await assert.rejects(market.eligibilityReviewQueue(user, {}), {
    code: "review_forbidden",
  });
  assert.equal(
    (
      await store.as(stranger, (c) =>
        c.query("SELECT * FROM campus.eligibility_requests"),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await store.as(stranger, (c) =>
        c.query("SELECT * FROM campus.eligibility_requests_visible()"),
      )
    ).rowCount,
    0,
  );
});

test("review queue is institution scoped, omits self review, and loses access immediately after role revocation", async () => {
  const self = await market.requestEligibility(reviewer, submission, key());
  await assert.rejects(
    market.decideEligibility(reviewer, self.id, approve(), key()),
    { code: "self_review_forbidden" },
  );
  const foreignSchool = key(),
    foreignUser = await f.user("Foreign applicant", false);
  await f.owner.query(
    "INSERT INTO campus.institutions VALUES($1,'Other School',true,'Synthetic test')",
    [foreignSchool],
  );
  await f.owner.query(
    "INSERT INTO campus.domains VALUES('other.example.test',$1,true,now())",
    [foreignSchool],
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET institution_id=$2,domain='other.example.test' WHERE user_id=$1",
    [foreignUser, foreignSchool],
  );
  const foreignRequest = await market.requestEligibility(
    foreignUser,
    submission,
    key(),
  );
  const queue = await market.eligibilityReviewQueue(reviewer, { limit: 100 });
  assert.ok(queue.items.length > 0);
  assert.ok(
    queue.items.every(
      (x) =>
        x.can_review &&
        x.institution_id === f.institution &&
        x.user_id !== reviewer,
    ),
  );
  assert.equal(
    queue.items.some((x) => x.id === foreignRequest.id),
    false,
  );
  await assert.rejects(
    market.decideEligibility(reviewer, foreignRequest.id, approve(), key()),
    { code: "not_found" },
  );
  const temp = await f.user("Temporary reviewer", false);
  await f.owner.query(
    "INSERT INTO campus.eligibility_reviewers VALUES($1,$2)",
    [temp, f.institution],
  );
  assert.equal((await market.me(temp)).can_review_eligibility, true);
  await f.owner.query(
    "DELETE FROM campus.eligibility_reviewers WHERE user_id=$1",
    [temp],
  );
  await assert.rejects(market.eligibilityReviewQueue(temp), {
    code: "review_forbidden",
  });
  assert.equal(
    (
      await store.as(temp, (c) =>
        c.query("SELECT * FROM campus.eligibility_requests_visible()"),
      )
    ).rowCount,
    0,
  );
});

test("rejection preserves history, permits a fresh request, and approval enables apply only until the recorded deadline", async () => {
  const { user, request } = await fresh("History applicant");
  const k = key(),
    rejected = await market.decideEligibility(reviewer, request.id, reject, k);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.review_reason, reject.reason);
  assert.deepEqual(
    await market.decideEligibility(reviewer, request.id, reject, k),
    rejected,
  );
  assert.equal(
    (await market.decideEligibility(reviewer2, request.id, reject, key()))
      .status,
    "rejected",
  );
  assert.equal((await market.me(user)).can_apply, false);
  const next = await market.requestEligibility(
    user,
    {
      ...submission,
      enrollmentSummary: "Revised current enrollment statement.",
    },
    key(),
  );
  assert.notEqual(next.id, request.id);
  const approval = approve(),
    approved = await market.decideEligibility(
      reviewer,
      next.id,
      approval,
      key(),
    );
  assert.equal(approved.status, "approved");
  assert.equal(approved.valid_until, approval.validUntil);
  assert.equal((await market.me(user)).can_apply, true);
  await store.as(user, (c) => member(c, user, { write: true, apply: true }));
  assert.equal((await market.myEligibilityRequests(user)).items.length, 2);
  await f.owner.query(
    "UPDATE campus.affiliations SET student_valid_until=now()-interval '1 second' WHERE user_id=$1",
    [user],
  );
  assert.equal((await market.me(user)).can_apply, false);
  await assert.rejects(
    store.as(user, (c) => member(c, user, { apply: true })),
    { code: "student_verification_required" },
  );
  await store.auth.query(
    "UPDATE campus.affiliations SET valid_until=now()+interval '1 year' WHERE user_id=$1",
    [user],
  );
  assert.equal(
    (await market.me(user)).can_apply,
    false,
    "renewing email ownership cannot renew student eligibility",
  );
  assert.equal(
    (await market.requestEligibility(user, submission, key())).status,
    "pending",
  );
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int AS n FROM campus.audit WHERE object_id=$1 AND action='eligibility.rejected'",
        [request.id],
      )
    ).rows[0].n,
    1,
  );
});

test("approval enforces expiry and current affiliation snapshot while rejection can resolve stale requests", async () => {
  const { user, request } = await fresh("Expiry applicant");
  for (const input of [
    approve(new Date(Date.now() - 1000).toISOString()),
    approve(expires(366)),
    { decision: "approved", reason: "Valid reason" },
    { ...reject, validUntil: expires() },
  ])
    await assert.rejects(
      market.decideEligibility(reviewer, request.id, input, key()),
      { status: 422 },
    );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()+interval '1 day' WHERE user_id=$1",
    [user],
  );
  await assert.rejects(
    market.decideEligibility(reviewer, request.id, approve(), key()),
    { code: "invalid_eligibility_expiry" },
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET valid_until=now()-interval '1 second' WHERE user_id=$1",
    [user],
  );
  await assert.rejects(
    market.decideEligibility(reviewer, request.id, approve(), key()),
    { code: "applicant_membership_changed" },
  );
  assert.equal(
    (await market.decideEligibility(reviewer, request.id, reject, key()))
      .status,
    "rejected",
  );
  const moved = await fresh("Moved applicant");
  await f.owner.query(
    "INSERT INTO campus.domains VALUES('new.example.test',$1,true,now())",
    [f.institution],
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET domain='new.example.test' WHERE user_id=$1",
    [moved.user],
  );
  await assert.rejects(
    market.decideEligibility(reviewer, moved.request.id, approve(), key()),
    { code: "applicant_membership_changed" },
  );
  const accepted = await fresh("Moving approved student");
  await market.decideEligibility(
    reviewer,
    accepted.request.id,
    approve(),
    key(),
  );
  await f.owner.query(
    "UPDATE campus.affiliations SET domain='new.example.test' WHERE user_id=$1",
    [accepted.user],
  );
  assert.equal((await market.me(accepted.user)).can_apply, false);
  assert.equal((await market.me(accepted.user)).student_valid_until, null);
});

test("concurrent reviewers produce one terminal decision and one audit event", async () => {
  const { user, request } = await fresh("Concurrent decision");
  const race = await Promise.allSettled([
    market.decideEligibility(reviewer, request.id, approve(), key()),
    market.decideEligibility(reviewer2, request.id, reject, key()),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    race.find((x) => x.status === "rejected").reason.code,
    "eligibility_decided",
  );
  const result = (await market.myEligibilityRequests(user)).items[0];
  assert.equal((await market.me(user)).can_apply, result.status === "approved");
  assert.equal(
    (
      await f.owner.query(
        "SELECT count(*)::int AS n FROM campus.audit WHERE object_id=$1 AND action IN ('eligibility.approved','eligibility.rejected')",
        [request.id],
      )
    ).rows[0].n,
    1,
  );
});

test("cursor pagination preserves microseconds and reads only the actor's history", async () => {
  const user = await f.user("Paged history", false),
    ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await market.requestEligibility(user, submission, key());
    ids.push(r.id);
    await market.decideEligibility(reviewer, r.id, reject, key());
    await f.owner.query(
      "UPDATE campus.eligibility_requests SET created_at='2026-10-13T00:00:00.000001Z'::timestamptz+$2*interval '1 microsecond' WHERE id=$1",
      [r.id, i],
    );
  }
  let cursor,
    seen = [];
  do {
    const page = await market.myEligibilityRequests(user, {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((x) => x.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ids.reverse());
  await assert.rejects(
    market.myEligibilityRequests(user, { cursor: "not a cursor" }),
    { code: "invalid_input" },
  );
});

test("production disables reviewer capability and decisions until administrator step-up is implemented", async () => {
  const prod = createMarket(store, { production: true });
  const receiptKey = key(),
    profile = { displayName: "Reviewer", bio: "" };
  assert.equal(
    (await market.updateProfile(reviewer, profile, receiptKey))
      .can_review_eligibility,
    true,
  );
  assert.equal(
    (await prod.updateProfile(reviewer, profile, receiptKey))
      .can_review_eligibility,
    false,
    "an older command receipt cannot restore production reviewer capability",
  );
  assert.equal((await prod.me(reviewer)).can_review_eligibility, false);
  assert.equal(
    (
      await prod.updateProfile(
        reviewer,
        { displayName: "Reviewer", bio: "" },
        key(),
      )
    ).can_review_eligibility,
    false,
  );
  await assert.rejects(prod.eligibilityReviewQueue(reviewer), {
    code: "review_not_available",
  });
  await assert.rejects(prod.decideEligibility(reviewer, key(), reject, key()), {
    code: "review_not_available",
  });
  const user = await f.user("Production requester", false);
  assert.equal(
    (await prod.requestEligibility(user, submission, key())).status,
    "pending",
  );
});

async function whileLocked(lock, command, mutate, observedQuery) {
  await f.owner.query("BEGIN");
  let running;
  try {
    await lock();
    running = command().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      await f.owner.query("SELECT pg_stat_clear_snapshot()");
      const row = await f.owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='campus_app' AND wait_event_type='Lock' AND query LIKE $1",
        [observedQuery],
      );
      if (row.rowCount) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      waiting,
      true,
      "observe the real PostgreSQL command waiting before revoking authority",
    );
    await mutate();
    await f.owner.query("COMMIT");
  } finally {
    await f.owner.query("ROLLBACK");
  }
  return running;
}

test("unknown-response retry rechecks reviewer authority after the actual idempotency lock wait", async () => {
  const temp = await f.user("Replay reviewer", false),
    { request } = await fresh("Replay applicant"),
    k = key();
  await f.owner.query(
    "INSERT INTO campus.eligibility_reviewers VALUES($1,$2)",
    [temp, f.institution],
  );
  await market.decideEligibility(temp, request.id, reject, k);
  const result = await whileLocked(
    () =>
      f.owner.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([temp, "eligibility.decision:" + request.id, k]),
      ]),
    () => market.decideEligibility(temp, request.id, reject, k),
    () =>
      f.owner.query(
        "DELETE FROM campus.eligibility_reviewers WHERE user_id=$1",
        [temp],
      ),
    "SELECT pg_advisory_xact_lock%",
  );
  assert.equal(result.error?.code, "review_forbidden");
  assert.equal(result.value, undefined);
});

test("a decision blocked on its request rechecks expired applicant membership using wall-clock time", async () => {
  const { user, request } = await fresh("Waiting applicant");
  const result = await whileLocked(
    () =>
      f.owner.query(
        "SELECT id FROM campus.eligibility_requests WHERE id=$1 FOR UPDATE",
        [request.id],
      ),
    () => market.decideEligibility(reviewer, request.id, approve(), key()),
    () =>
      f.owner.query(
        "UPDATE campus.affiliations SET valid_until=clock_timestamp()-interval '1 millisecond' WHERE user_id=$1",
        [user],
      ),
    "SELECT campus.decide_student_eligibility%",
  );
  assert.equal(result.error?.code, "applicant_membership_changed");
  assert.equal(
    (await market.myEligibilityRequests(user)).items[0].status,
    "pending",
  );
  assert.equal((await market.me(user)).can_apply, false);
});

test("eligibility expires within an open transaction and restriction immediately removes capability", async () => {
  const student = await f.user("Expiring student", true);
  await store.as(student, async (c) => {
    await f.owner.query(
      "UPDATE campus.affiliations SET student_valid_until=clock_timestamp()+interval '80 milliseconds' WHERE user_id=$1",
      [student],
    );
    assert.equal((await account(c, student)).can_apply, true);
    await c.query("SELECT pg_sleep(0.1)");
    assert.equal(
      (await account(c, student)).can_apply,
      false,
      "transaction-start now() must not extend the grant",
    );
  });
  await f.owner.query(
    "UPDATE campus.affiliations SET student_valid_until=now()+interval '1 day' WHERE user_id=$1",
    [student],
  );
  await f.owner.query(
    "UPDATE campus.users SET account_status='restricted' WHERE id=$1",
    [student],
  );
  assert.equal((await market.me(student)).can_apply, false);
});

test("reviewer can recover a decided request by id, while self, outsider, revoked and production reads are denied", async () => {
  const { user, request } = await fresh("Recovery applicant");
  assert.equal(
    (await market.eligibilityReview(reviewer, request.id)).status,
    "pending",
  );
  const decided = await market.decideEligibility(
    reviewer,
    request.id,
    reject,
    key(),
  );
  const recovered = await market.eligibilityReview(reviewer, request.id);
  assert.equal(recovered.status, "rejected");
  assert.equal(recovered.review_reason, decided.review_reason);
  await assert.rejects(market.eligibilityReview(user, request.id), {
    code: "review_forbidden",
  });
  await assert.rejects(market.eligibilityReview(stranger, request.id), {
    code: "review_forbidden",
  });
  const self = (await market.myEligibilityRequests(reviewer)).items[0];
  await assert.rejects(market.eligibilityReview(reviewer, self.id), {
    code: "review_forbidden",
  });
  const temp = await f.user("Read revoked reviewer", false);
  await f.owner.query(
    "INSERT INTO campus.eligibility_reviewers VALUES($1,$2)",
    [temp, f.institution],
  );
  assert.equal(
    (await market.eligibilityReview(temp, request.id)).id,
    request.id,
  );
  await f.owner.query(
    "DELETE FROM campus.eligibility_reviewers WHERE user_id=$1",
    [temp],
  );
  await assert.rejects(market.eligibilityReview(temp, request.id), {
    code: "review_forbidden",
  });
  await assert.rejects(
    createMarket(store, { production: true }).eligibilityReview(
      reviewer,
      request.id,
    ),
    { code: "review_not_available" },
  );
});
