import test from "node:test";
import assert from "node:assert/strict";
import { isolated, key } from "./transaction-ui-fixture.mjs";
import { configure } from "./transaction-ui-setup.mjs";
import { agreement, quoteAgreement } from "./transaction-ui-journeys.mjs";

test("no webhook recovery waits for the real scheduled own reconciliation job without clock or state repair", async () => {
  const f = await isolated(2);
  try {
    await f.migrateThrough(22);
    const x = await configure(f),
      s = await quoteAgreement(f, await agreement(f));
    const a = (
      await f.market.createPaymentAttempt(
        s.P,
        s.q.obligationId,
        s.attemptRequest,
        key(),
      )
    ).receipt;
    await x.worker.dispatch();
    const attempt = await f.market.paymentAttempt(s.P, a.attemptId);
    assert.equal(attempt.status, "requires_action");
    assert(attempt.sessionId);
    await x.worker.reconcile();
    const ownJob = async () =>
      (
        await f.owner.query(
          "SELECT id,kind,resource_key,status,available_at,observations,last_code FROM campus.payment_reconciliation_jobs WHERE environment_id=$1 AND kind=$2 AND resource_key=$3",
          [x.env.id, "attempt", attempt.sessionId],
        )
      ).rows[0];
    const before = await ownJob();
    assert.equal(before.status, "pending");
    assert.equal(before.last_code, "pending");
    assert.equal(before.observations, 1);
    assert(new Date(before.available_at).getTime() > Date.now());
    x.transport.pay(attempt.sessionId, { fee: 100, available: true });
    assert.equal(
      (await f.market.agreementFunding(s.P, s.g.id)).coverage,
      "insufficient",
    );
    const started = Date.now();
    let current;
    while (Date.now() - started < 40000) {
      await x.worker.reconcile();
      current = await ownJob();
      if (current.status === "done") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(current.status, "done");
    assert.equal(current.observations, 2);
    const funding = await f.market.agreementFunding(s.P, s.g.id);
    assert.equal(funding.coverage, "covered");
    assert.equal(funding.receivedCents, "10055");
    assert.equal(
      (await f.owner.query("SELECT count(*)::int n FROM campus.provider_inbox"))
        .rows[0].n,
      0,
    );
    console.log(
      JSON.stringify({
        before,
        after: current,
        elapsedMs: Date.now() - started,
        attemptId: a.attemptId,
        operationId: a.operationId,
        funding,
        synthetic: true,
        webhooks: 0,
      }),
    );
  } finally {
    await f.close();
  }
});
