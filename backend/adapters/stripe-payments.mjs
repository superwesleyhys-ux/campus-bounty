import {
  FEE_REPORT_TYPE,
  parseFeeCsv,
  sha256,
  downloadStripeReport,
} from "../payments/fee-reports.mjs";
import Stripe from "stripe";
export const STRIPE_API_VERSION = "2026-09-30.endive";
export const SNAPSHOT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "charge.updated",
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "transfer.created",
  "transfer.updated",
  "transfer.reversed",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  "payout.reconciliation_completed",
]);
export const THIN_EVENTS = new Set([
  "v2.core.account[configuration.recipient].capability_status_updated",
  "v2.core.account[configuration.recipient].updated",
  "v2.core.account[requirements].updated",
  "v2.core.account[future_requirements].updated",
  "v2.core.account.updated",
  "v2.core.account.closed",
  "v2.core.account_link.returned",
]);
const id = (x) => (typeof x === "string" ? x : x?.id);
export function createStripePayments({
  secret,
  client,
  environment,
  snapshotSecret,
  thinSecret,
  reportTransport,
}) {
  if (
    !environment?.id ||
    !environment.platformAccountId ||
    !["sandbox", "live"].includes(environment.mode)
  )
    throw Error("provider_configuration_unavailable");
  const stripe =
    client ??
    new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: 15000,
    });
  const options = (op) => ({ idempotencyKey: op.provider_key });
  return {
    environment,
    async listFeeBalances(cursor) {
      return stripe.balanceTransactions.list({
        limit: 16,
        type: "stripe_fee",
        ...(cursor ? { starting_after: cursor } : {}),
      });
    },
    async listFeeReports(cursor) {
      return stripe.reporting.reportRuns.list({
        limit: 16,
        ...(cursor ? { starting_after: cursor } : {}),
      });
    },
    async retrieveFeeReport(runId) {
      const run = await stripe.reporting.reportRuns.retrieve(runId);
      if (
        run.id !== runId ||
        run.livemode !== (environment.mode === "live") ||
        run.report_type !== FEE_REPORT_TYPE ||
        run.parameters.connected_account ||
        (run.parameters.currency &&
          run.parameters.currency.toLowerCase() !== "usd")
      )
        throw Error("provider_scope_mismatch");
      if (run.status !== "succeeded") return { status: run.status };
      if (!run.result?.id || run.result.purpose !== "finance_report_run")
        throw Error("fee_report_result_invalid");
      const file = await stripe.files.retrieve(run.result.id);
      if (
        file.id !== run.result.id ||
        file.purpose !== "finance_report_run" ||
        !file.url ||
        file.size > 8 * 1024 * 1024
      )
        throw Error("fee_report_result_invalid");
      const text = await (
        reportTransport ?? ((url) => downloadStripeReport(url, secret))
      )(file.url);
      return {
        status: "succeeded",
        runId,
        fileId: file.id,
        contentDigest: sha256(text),
        reportType: run.report_type,
        intervalStart: run.parameters.interval_start,
        intervalEnd: run.parameters.interval_end,
        rows: parseFeeCsv(text, environment.platformAccountId),
      };
    },
    async createCheckout(op) {
      const p = op.payload;
      return stripe.checkout.sessions.create(
        {
          mode: "payment",
          ui_mode: "hosted_page",
          ...(p.paymentMethodTypes
            ? { payment_method_types: p.paymentMethodTypes }
            : {}),
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: Number(p.amountCents),
                product_data: { name: "Campus Bounty agreed transaction" },
              },
              quantity: 1,
            },
          ],
          client_reference_id: p.attemptId,
          metadata: {
            attemptId: p.attemptId,
            obligationId: p.obligationId,
            sourceDigest: p.sourceDigest,
            quoteDigest: p.quoteDigest,
            operationId: op.id,
          },
          payment_intent_data: {
            transfer_group: p.obligationId,
            metadata: {
              attemptId: p.attemptId,
              obligationId: p.obligationId,
              sourceDigest: p.sourceDigest,
              operationId: op.id,
            },
          },
          success_url: p.returnUrl,
          cancel_url: p.returnUrl,
          integration_identifier: p.integrationIdentifier,
        },
        options(op),
      );
    },
    async retrieveCheckoutAndPayment(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const intent = id(session.payment_intent)
        ? await stripe.paymentIntents.retrieve(id(session.payment_intent))
        : null;
      const charge = id(intent?.latest_charge)
        ? await stripe.charges.retrieve(id(intent.latest_charge))
        : null;
      const balance = id(charge?.balance_transaction)
        ? await stripe.balanceTransactions.retrieve(
            id(charge.balance_transaction),
          )
        : null;
      return { session, intent, charge, balance };
    },
    expireCheckout: (op) =>
      stripe.checkout.sessions.expire(op.payload.sessionId, {}, options(op)),
    createTransfer: (op) =>
      stripe.transfers.create(
        {
          amount: Number(op.payload.amountCents),
          currency: "usd",
          destination: op.payload.destination,
          source_transaction: op.payload.sourceCharge,
          transfer_group: op.payload.transferGroup,
          metadata: { operationId: op.id, componentId: op.payload.componentId },
        },
        options(op),
      ),
    retrieveCharge: (chargeId) => stripe.charges.retrieve(chargeId),
    retrieveTransfer: (transferId) => stripe.transfers.retrieve(transferId),
    createRefund: (op) =>
      stripe.refunds.create(
        {
          charge: op.payload.sourceCharge,
          amount: Number(op.payload.amountCents),
          metadata: { operationId: op.id },
        },
        options(op),
      ),
    retrieveRefund: (refundId) => stripe.refunds.retrieve(refundId),
    async compensationBalances(object) {
      const id = (value) => (typeof value === "string" ? value : value?.id);
      return {
        original: id(object.balance_transaction)
          ? await stripe.balanceTransactions.retrieve(
              id(object.balance_transaction),
            )
          : null,
        failure: id(object.failure_balance_transaction)
          ? await stripe.balanceTransactions.retrieve(
              id(object.failure_balance_transaction),
            )
          : null,
      };
    },
    listReversals: (transferId, startingAfter) =>
      stripe.transfers.listReversals(transferId, {
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      }),
    retrieveReversal: (transferId, reversalId) =>
      stripe.transfers.retrieveReversal(transferId, reversalId),
    retrieveDispute: (disputeId) => stripe.disputes.retrieve(disputeId),
    retrieveBalance: (balanceId) =>
      stripe.balanceTransactions.retrieve(balanceId),
    retrievePayout: (payoutId, accountId) =>
      stripe.payouts.retrieve(payoutId, {}, { stripeContext: accountId }),
    retrieveThinEvent: (eventId, context) =>
      stripe.v2.core.events.retrieve(
        eventId,
        {},
        context ? { stripeContext: context } : {},
      ),
    reverseTransfer: (op) =>
      stripe.transfers.createReversal(
        op.payload.transferId,
        {
          amount: Number(op.payload.amountCents),
          metadata: { operationId: op.id },
        },
        options(op),
      ),
    async retrieveRecipientCapabilities(accountId) {
      const a = await stripe.v2.core.accounts.retrieve(accountId, {
        include: ["configuration.recipient", "requirements"],
      });
      if (a.id !== accountId) throw Error("provider_scope_mismatch");
      const balance = a.configuration?.recipient?.capabilities?.stripe_balance;
      return {
        accountId: a.id,
        transferCapability: balance?.stripe_transfers?.status ?? "unknown",
        payoutCapability: balance?.payouts?.status ?? "unknown",
        observedAt: new Date().toISOString(),
        requirements: {
          pendingCount: Math.min(a.requirements?.entries?.length ?? 0, 10000),
          status: !a.requirements
            ? "unknown"
            : !a.requirements.entries?.length
              ? "none"
              : a.requirements.entries.some(
                    (r) => r.minimum_deadline?.status === "past_due",
                  )
                ? "past_due"
                : a.requirements.entries.some(
                      (r) => r.awaiting_action_from === "user",
                    )
                  ? "currently_due"
                  : "pending_verification",
        },
      };
    },
    createRecipient: (op) =>
      stripe.v2.core.accounts.create(op.payload.account, options(op)),
    createOnboarding: (op) =>
      stripe.v2.core.accountLinks.create(
        {
          account: op.payload.accountId,
          use_case: {
            type: "account_onboarding",
            account_onboarding: {
              refresh_url: op.payload.refreshUrl,
              return_url: op.payload.returnUrl,
            },
          },
        },
        options(op),
      ),
    parseWebhook(bytes, signature, thin = false) {
      if (!Buffer.isBuffer(bytes) || bytes.length > 262144)
        throw Error("invalid_webhook");
      const secret = thin ? thinSecret : snapshotSecret;
      if (!secret) throw Error("webhook_secret_unavailable");
      const event = thin
        ? stripe.parseEventNotification(
            bytes.toString("utf8"),
            signature,
            secret,
          )
        : stripe.webhooks.constructEvent(bytes, signature, secret, 300);
      const context = thin ? event.context?.toString() : event.account;
      const origin = context ?? environment.platformAccountId;
      if (event.livemode !== (environment.mode === "live"))
        throw Error("provider_scope_mismatch");
      return {
        event,
        origin,
        body: JSON.parse(bytes.toString("utf8")),
        supported: (thin ? THIN_EVENTS : SNAPSHOT_EVENTS).has(event.type),
      };
    },
  };
}
