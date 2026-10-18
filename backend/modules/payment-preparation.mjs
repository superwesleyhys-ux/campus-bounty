import { parse, uuid } from './common.mjs';
import { account, member, idempotent } from '../db/store.mjs';
import { moneySql } from './payments.mjs';
import { Problem } from '../errors.mjs';
import {preparationSchema,preparationReceiptSchema,recipientPreparationReceiptSchema,participantPaymentSchema} from '../payments/preparation-models.mjs';
export {preparationSchema};
export function paymentPreparationModule(store, {paymentEnabled = false} = {}) {
  async function prepare(actor, kind, id, input, key) {
    if (!paymentEnabled) throw new Problem(503, 'payments_unavailable', 'Payment preparation is unavailable. Existing status remains readable.');
    if (id) uuid(id);
    const body = parse(preparationSchema, input);
    return store.as(actor, async c => {
      await account(c, actor); await member(c, actor, {write:true});
      const receipt = await idempotent(c, actor, `payment.prepare:${kind}:${id ?? actor}`, key, body, async () =>
        (await moneySql(c, kind === 'recipient' ? 'SELECT campus.prepare_recipient_configuration() result' : 'SELECT campus.prepare_payment_terms($1,$2) result', kind === 'recipient' ? [] : [kind,id])).rows[0].result);
      await member(c, actor, {write:true});
      return {receipt:(kind==='recipient'?recipientPreparationReceiptSchema:preparationReceiptSchema).parse(receipt)};
    });
  }
  return {
    preparePaymentTerms: (actor, kind, id, input, key) => prepare(actor,kind,id,input,key),
    preparePaymentRecipient: (actor,input,key) => prepare(actor,'recipient',null,input,key),
    participantPayment: (actor, kind, id) => {
      uuid(id);
      return store.as(actor, async c => {
        await account(c,actor);
        const result = (await moneySql(c,'SELECT campus.participant_payment_read($1,$2) result',[kind,id])).rows[0].result;
        return participantPaymentSchema.parse({...result, paymentEnabled});
      });
    },
  };
}
