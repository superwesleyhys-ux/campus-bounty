// Ordinary completed-state checks only; no queued authorization/race reproduction.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID as key } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { createStore } from "../../backend/db/store.mjs";
import { createMarket } from "../../backend/modules/market.mjs";
import { localConfig, connectionString } from "../../scripts/backend-local.mjs";
assert.equal(
  new URL(connectionString(localConfig(), "migrator")).hostname,
  "127.0.0.1",
);
const f = await fixture(),
  store = createStore(f.urls),
  market = createMarket(store);
assert.match(
  f.owner.connectionParameters.database,
  /^campus_test_[a-f0-9]{32}$/,
);
test.after(async () => {
  await store.close();
  await f.close();
});
test("013 ordinary publisher, captain and signer sends; removed signer denied without message/notification/receipt changes", async () => {
  const owner = await f.user("013 Publisher"),
    captain = await f.user("013 Captain"),
    peer = await f.user("013 Signer");
  const task = await market.publishTask(
    owner,
    {
      title: "013 ordinary scope",
      category: "Research",
      description: "Synthetic",
      rewardCents: 100,
      milestones: [{ title: "One", amountCents: 100, deliverable: "Local" }],
    },
    key(),
  );
  const application = await market.apply(
    captain,
    task.id,
    { proposal: "Local" },
    key(),
  );
  await market.inviteApplicant(owner, application.id, {}, key());
  const agreement = await market.acceptInvitation(
    captain,
    application.id,
    {},
    key(),
  );
  await f.owner.query(
    "INSERT INTO campus.agreement_members(agreement_id,user_id) VALUES($1,$2)",
    [agreement.id, peer],
  );
  const input = { agreementId: agreement.id, body: "Ordinary signer receipt" },
    requestKey = key();
  await market.sendMessage(peer, input, requestKey);
  for (const actor of [owner, captain, peer])
    await store.as(actor, (c) =>
      c.query(
        "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'Ordinary raw send')",
        [actor, agreement.id],
      ),
    );
  // Finish removal before attempting any subsequent authorization or INSERT.
  await f.owner.query(
    "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
    [agreement.id, peer],
  );
  const counts = async () =>
    (
      await f.owner.query(
        "SELECT (SELECT count(*) FROM campus.messages)::int AS messages,(SELECT count(*) FROM campus.notifications)::int AS notifications,(SELECT count(*) FROM campus.idempotency)::int AS receipts",
      )
    ).rows[0];
  const before = await counts();
  await assert.rejects(
    store.as(peer, (c) =>
      c.query("SELECT campus.authorize_message_scope('agreement',$1)", [
        agreement.id,
      ]),
    ),
    (e) => e.code === "P0001" && e.message === "not_found",
  );
  await assert.rejects(
    store.as(peer, (c) =>
      c.query(
        "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'Denied ordinary send')",
        [peer, agreement.id],
      ),
    ),
    (e) => e.code === "P0001" && e.message === "not_found",
  );
  await assert.rejects(
    market.sendMessage(peer, input, requestKey),
    (e) => e.code === "not_found",
  );
  assert.deepEqual(await counts(), before);
  // Frozen captain authority is independent of a membership row, as is publisher authority.
  await f.owner.query(
    "DELETE FROM campus.agreement_members WHERE agreement_id=$1 AND user_id=$2",
    [agreement.id, captain],
  );
  for (const actor of [owner, captain]) {
    await store.as(actor, (c) =>
      c.query(
        "INSERT INTO campus.messages(sender_id,agreement_id,body) VALUES($1,$2,'Authorized role without member row')",
        [actor, agreement.id],
      ),
    );
    await market.sendMessage(
      actor,
      { agreementId: agreement.id, body: "Role authority retained" },
      key(),
    );
  }
});
test("013 retains volatile definer, fixed search path and private function grants", async () => {
  const fn = (
    await f.owner.query(
      "SELECT p.provolatile,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid='campus.authorize_message_scope(text,uuid)'::regprocedure",
    )
  ).rows[0];
  assert.equal(fn.provolatile, "v");
  assert.equal(fn.prosecdef, true);
  assert.deepEqual(fn.proconfig, ["search_path=pg_catalog, campus, pg_temp"]);
  assert.match(fn.definition, /member_locked := FOUND/);
  const acl = (
    await f.owner.query(
      "SELECT has_function_privilege('campus_app','campus.authorize_message_scope(text,uuid)','EXECUTE') AS app,has_function_privilege('campus_auth','campus.authorize_message_scope(text,uuid)','EXECUTE') AS auth,has_function_privilege('campus_worker','campus.authorize_message_scope(text,uuid)','EXECUTE') AS worker,EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE p.oid='campus.authorize_message_scope(text,uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public",
    )
  ).rows[0];
  assert.deepEqual(acl, {
    app: true,
    auth: false,
    worker: false,
    public: false,
  });
});
