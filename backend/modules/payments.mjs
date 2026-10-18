import {feePlanProposalSchema,feePlanConfirmationSchema,feePlanReadSchema,feePlanProposalResponseSchema,feePlanConfirmationResponseSchema} from '../payments/fee-plan-models.mjs';
import {paymentCommandSchemas} from '../payments/command-models.mjs';
import {
  fundingReadSchema,
  orderPaymentReadSchema,
  accountReadSchema,
  attemptReadSchema,
  operationReadSchema,
} from "../payments/read-models.mjs";
import { z, parse, uuid } from "./common.mjs";
import { account, member, idempotent } from "../db/store.mjs";
import { Problem } from "../errors.mjs";
export const paymentQuoteSchema = z.strictObject({
  expectedEffectiveTermsId: z.uuid(),
  expectedEffectiveRevision: z.number().int().positive(),
  transactionTermsId: z.uuid(),
  transactionTermsRevision: z.number().int().positive(),
});
export const paymentAttemptSchema = z.strictObject({
  quoteId: z.uuid(),
  quoteDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedObligationRevision: z.number().int().positive(),
  acceptedAmountCents: z.number().int().positive().max(100000000),
  currency: z.literal("USD"),
});
export const orderPaymentQuoteSchema = z.strictObject({
  orderTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPaymentRevision: z.number().int().nonnegative(),
});
export const paymentPolicyConfirmationSchema = z.strictObject({
  expectedPaymentRevision: z.number().int().nonnegative(),
  orderTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersionId: z.uuid(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const paymentCancellationSchema = z.strictObject({
  expectedPaymentRevision: z.number().int().positive(),
  orderTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const onboardingSchema = z.strictObject({
  expectedAccountRevision: z.number().int().nonnegative(),
});
export const refundRequestSchema = z.strictObject({
  obligationId: z.uuid(),
  chargeId: z.string().min(1).max(200),
  expectedPaymentRevision: z.number().int().positive(),
  amountCents: z.number().int().positive().max(100000000),
  reason: z.string().trim().min(1).max(2000),
  policyVersionId: z.uuid(),
});
export const disputeSchema = z.strictObject({
  expectedPaymentRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
  relatedMilestoneId: z.uuid().optional(),
  relatedSubmissionId: z.uuid().optional(),
});
export async function moneySql(c, sql, args = []) {
  try {
    return await c.query(sql, args);
  } catch (e) {
    if (e.code === "P0001" && /^[a-z_]+$/.test(e.message))
      throw new Problem(
        e.message === "not_found"
          ? 404
          : e.message === "payments_unavailable"
            ? 503
            : 409,
        e.message,
        "Read the current payment status. Do not start another payment while its outcome is unknown.",
      );
    throw e;
  }
}
async function available(c) {
  if (
    !(
      await c.query(
        "SELECT to_regprocedure('campus.money_capabilities()') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    throw new Problem(
      503,
      "payments_unavailable",
      "Payments are unavailable on this release.",
    );
}
export function paymentModule(store, {paymentEnabled=false}={}) {
  const actionAvailable=()=>{if(!paymentEnabled)throw new Problem(503,'payments_unavailable','New payment actions are unavailable. Existing payment status remains readable.');};
  const read = (actor, fn) =>
    store.as(actor, async (c) => {
      await account(c, actor);
      await available(c);
      return fn(c);
    });
  const checked = async (c, sql, args, schema) =>
    schema.parse((await moneySql(c, sql, args)).rows[0].result);
  const projection = (c, kind, id) =>
    moneySql(c, "SELECT campus.money_projection($1,$2) AS result", [
      kind,
      id,
    ]).then((r) => {const value=fundingReadSchema.parse(r.rows[0].result);return paymentEnabled?value:{...value,allowedActions:value.allowedActions.filter(a=>['refresh','refresh_attempt','open_dispute','request_refund_review'].includes(a)),blockedReasons:[...new Set([...value.blockedReasons,'payments_unavailable'])]};});
  async function command(actor, id, input, key, schema, kind, fn) {
    actionAvailable();
    uuid(id);
    const d = parse(schema, input);
    return read(actor, async (c) => {
      await member(c, actor, { write: true });
      await projection(c, kind, id);
      const receipt = await idempotent(
        c,
        actor,
        "payment." + fn + ":" + id,
        key,
        d,
        async () =>
          (
            await moneySql(c, `SELECT campus.${fn}($1,$2) AS result`, [
              id,
              JSON.stringify(d),
            ])
          ).rows[0].result,
      );
      await member(c, actor, { write: true });
      return paymentCommandSchemas[fn].parse({ receipt, current: await projection(c, kind, id) });
    });
  }
  async function caseCommand(actor, kind, id, input, key, schema, fn) {
    uuid(id);
    const d = parse(schema, input);
    return read(actor, async (c) => {
      await member(c, actor, { write: true });
      await projection(c, kind, id);
      const receipt = await idempotent(
        c,
        actor,
        "payment." + fn + ":" + kind + ":" + id,
        key,
        d,
        async () =>
          (
            await moneySql(c, `SELECT campus.${fn}($1,$2,$3) AS result`, [
              kind,
              id,
              JSON.stringify(d),
            ])
          ).rows[0].result,
      );
      await member(c, actor, { write: true });
      return paymentCommandSchemas[fn].parse({ receipt, current: await projection(c, kind, id) });
    });
  }
  return {
    paymentFeePlan:(actor,kind,id)=>{uuid(id);return read(actor,async c=>feePlanReadSchema.parse((await moneySql(c,'SELECT campus.money_fee_plan_read($1,$2) AS result',[kind,id])).rows[0].result));},
    proposePaymentFeePlan:async(actor,kind,id,input,key)=>{
      actionAvailable();uuid(id);const d=parse(feePlanProposalSchema,input);
      return read(actor,async c=>{await member(c,actor,{write:true});const receipt=await idempotent(c,actor,'payment.fee_plan:'+kind+':'+id,key,d,async()=> (await moneySql(c,'SELECT campus.money_fee_plan_propose($1,$2,$3) AS result',[kind,id,JSON.stringify(d)])).rows[0].result);await member(c,actor,{write:true});return feePlanProposalResponseSchema.parse({receipt,current:(await moneySql(c,'SELECT campus.money_fee_plan_read($1,$2) AS result',[kind,id])).rows[0].result});});
    },
    confirmPaymentFeePlan:async(actor,id,input,key)=>{
      actionAvailable();uuid(id);const d=parse(feePlanConfirmationSchema,input);
      return read(actor,async c=>{await member(c,actor,{write:true});const receipt=await idempotent(c,actor,'payment.fee_plan_confirm:'+id,key,d,async()=> (await moneySql(c,'SELECT campus.money_fee_plan_confirm($1,$2) AS result',[id,JSON.stringify(d)])).rows[0].result);await member(c,actor,{write:true});return feePlanConfirmationResponseSchema.parse({receipt,current:(await moneySql(c,'SELECT campus.money_fee_plan_current($1) AS result',[id])).rows[0].result});});
    },
    requestPaymentRefund: (a, kind, id, d, k) =>
      caseCommand(
        a,
        kind,
        id,
        d,
        k,
        refundRequestSchema,
        "money_refund_request",
      ),
    openPaymentDispute: (a, kind, id, d, k) =>
      caseCommand(a, kind, id, d, k, disputeSchema, "money_open_dispute"),
    paymentAccount: (actor) =>
      read(actor, async (c) =>
        checked(
          c,
          "SELECT campus.money_account() AS result",
          [],
          accountReadSchema,
        ),
      ),
    onboardPaymentAccount: (actor, input, key) => {
      actionAvailable();
      const d = parse(onboardingSchema, input);
      return read(actor, async (c) => {
        await member(c, actor, { write: true });
        const receipt = await idempotent(
          c,
          actor,
          "payment.onboarding",
          key,
          d,
          async () =>
            (
              await moneySql(
                c,
                "SELECT campus.money_onboarding($1) AS result",
                [JSON.stringify(d)],
              )
            ).rows[0].result,
        );
        await member(c, actor, { write: true });
        return paymentCommandSchemas.money_onboarding.parse({
          receipt,
          current: await checked(
            c,
            "SELECT campus.money_account() AS result",
            [],
            accountReadSchema,
          ),
        });
      });
    },
    agreementFunding: (actor, id) => {
      uuid(id);
      return read(actor, (c) => projection(c, "agreement", id));
    },
    orderPayment: (actor, id) => {
      uuid(id);
      return read(actor, async (c) =>
        orderPaymentReadSchema.parse({
          ...(await projection(c, "order", id)),
          financialPolicy: (
            await moneySql(
              c,
              "SELECT campus.money_order_policy($1) AS result",
              [id],
            )
          ).rows[0].result,
        }),
      );
    },
    confirmOrderPaymentPolicy: (a, id, d, k) =>
      command(
        a,
        id,
        d,
        k,
        paymentPolicyConfirmationSchema,
        "order",
        "money_order_confirm",
      ),
    cancelPaymentOrder: (a, id, d, k) =>
      command(
        a,
        id,
        d,
        k,
        paymentCancellationSchema,
        "order",
        "money_cancel_order",
      ),
    createAgreementPaymentQuote: (a, id, d, k) =>
      command(
        a,
        id,
        d,
        k,
        paymentQuoteSchema,
        "agreement",
        "money_agreement_quote",
      ),
    createOrderPaymentQuote: (a, id, d, k) =>
      command(
        a,
        id,
        d,
        k,
        orderPaymentQuoteSchema,
        "order",
        "money_order_quote",
      ),
    createPaymentAttempt: (actor, id, input, key) => {
      actionAvailable();
      uuid(id);
      const d = parse(paymentAttemptSchema, input);
      return read(actor, async (c) => {
        await member(c, actor, { write: true });
        await moneySql(c, "SELECT campus.money_authorize_payer($1)", [id]);
        const receipt = await idempotent(
          c,
          actor,
          "payment.attempt:" + id,
          key,
          d,
          async () =>
            (
              await moneySql(
                c,
                "SELECT campus.money_attempt($1,$2) AS result",
                [id, JSON.stringify(d)],
              )
            ).rows[0].result,
        );
        await member(c, actor, { write: true });
        await moneySql(c, "SELECT campus.money_authorize_payer($1)", [id]);
        return paymentCommandSchemas.money_attempt.parse({
          receipt,
          current: await checked(
            c,
            "SELECT campus.money_read_attempt($1) AS result",
            [receipt.attemptId],
            attemptReadSchema,
          ),
        });
      });
    },
    paymentAttempt: (actor, id) => {
      uuid(id);
      return read(actor, async (c) =>
        checked(
          c,
          "SELECT campus.money_read_attempt($1) AS result",
          [id],
          attemptReadSchema,
        ),
      );
    },
    moneyOperation: (actor, id) => {
      uuid(id);
      return read(actor, async (c) =>
        checked(
          c,
          "SELECT campus.money_read_operation($1) AS result",
          [id],
          operationReadSchema,
        ),
      );
    },
  };
}
