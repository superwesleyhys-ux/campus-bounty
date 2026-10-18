import {
  reconcilePayment,
  reconcileTransfer,
  reconcileCompensation,
  reconcileExternalCompensation,
} from "./reconciliation.mjs";
export function createPosting(store) {
  return {
    async externalCompensation(kind, object, balances, expected) {
      const fact = reconcileExternalCompensation(
        kind,
        object,
        balances,
        expected,
      );
      return store.workerTx(async (c) => {
        const result=await c.query("SELECT campus.money_external_compensation($1,$2,$3)", [
          expected.environmentId,
          expected.chargeId,
          JSON.stringify(fact),
        ]);
        await c.query("SELECT campus.money_reconcile_schedule($1,$2,$3,$4)",[expected.environmentId,"external_"+kind,object.id,JSON.stringify(expected)]);
        return result;
      });
    },
    async payment(expected, objects) {
      const fact = reconcilePayment(expected, objects);
      if(expected.feeRevisionId)return store.workerTx(async c=>{
        const result=(await c.query(expected.inboxId?'SELECT campus.money_record_supplement_inbox($1,$2,$3) AS result':'SELECT campus.money_fee_supplement_fact($1,$2) AS result',expected.inboxId?[expected.id,JSON.stringify(fact),expected.inboxId]:[expected.id,JSON.stringify(fact)])).rows[0].result;
        await c.query("SELECT campus.money_reconcile_schedule($1,'fee_supplement',$2,'{}')",[expected.environmentId,expected.sessionId]);return result;
      });
      if (fact.status === "terminal_unpaid") {
        await store.workerTx((c) =>
          c.query("SELECT campus.money_terminal_unpaid($1,$2)", [
            expected.id,
            JSON.stringify({ ...fact, sessionId: expected.sessionId }),
          ]),
        );
        return fact;
      }
      if (fact.status !== "succeeded") {
        await store.workerTx(c=>c.query("SELECT campus.money_attempt_observe($1,$2)",[expected.id,fact.status]));
        return fact;
      }
      return store.workerTx(
        async (c) => {
          const result=(
            await c.query(
              expected.inboxId
                ? "SELECT campus.money_record_inbox_receipt($1,$2,$3) AS result"
                : "SELECT campus.money_record_receipt($1,$2) AS result",
              expected.inboxId
                ? [expected.id, JSON.stringify(fact), expected.inboxId]
                : [expected.id, JSON.stringify(fact)],
            )
          ).rows[0].result;
          await c.query("SELECT campus.money_reconcile_schedule($1,'attempt',$2,'{}'::jsonb)",[expected.environmentId,expected.sessionId]);
          return result;
        },
      );
    },
    async compensation(operation, object, balances = {}) {
      const fact = reconcileCompensation(operation, object, balances);
      return store.workerTx(
        async (c) => {
          const result=(
            await c.query(
              operation.kind === "fee_restitution"
                ? "SELECT campus.money_restitution_fact($1,$2) AS result"
                : "SELECT campus.money_compensation_fact($1,$2) AS result",
              [operation.id, JSON.stringify(fact)],
            )
          ).rows[0].result;
          await c.query("SELECT campus.money_reconcile_schedule($1,'compensation',$2,'{}'::jsonb)",[operation.environment_id,operation.id]);
          return result;
        },
      );
    },
    async transfer(operation, object) {
      const fact = reconcileTransfer(operation, object);
      return store.workerTx((c) =>
        c.query("SELECT campus.money_transfer_fact($1,$2)", [
          operation.id,
          JSON.stringify(fact),
        ]),
      );
    },
  };
}
