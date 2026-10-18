const identity = (x) => (typeof x === "string" ? x : x?.id);
const reject = () => {
  throw Object.assign(new Error("provider_fact_mismatch"), {
    code: "provider_fact_mismatch",
  });
};
// Inputs are freshly retrieved provider objects, never browser JSON. Metadata alone cannot bind a charge.
export function reconcilePayment(
  expected,
  { session, intent, charge, balance },
) {
  if (
    !session ||
    session.id !== expected.sessionId ||
    session.mode !== "payment" ||
    session.amount_total !== Number(expected.amountCents) ||
    session.currency !== "usd" ||
    session.livemode !== (expected.mode === "live") ||
    session.client_reference_id !== expected.id ||
    session.metadata?.obligationId !== expected.obligationId ||
    session.metadata?.sourceDigest !== expected.sourceDigest ||
    session.metadata?.quoteDigest !== expected.quoteDigest
  )
    reject();
  const observation={sessionId:session.id,intentId:intent?.id??null};
  if (!intent)
    return {
      ...observation,
      status: session.status === "expired" ? "terminal_unpaid" : session.status === "open" ? "requires_action" : "processing",
    };
  if (
    identity(session.payment_intent) !== intent.id ||
    intent.amount !== Number(expected.amountCents) ||
    intent.currency !== "usd" ||
    intent.livemode !== (expected.mode === "live") ||
    intent.metadata?.attemptId !== expected.id ||
    intent.metadata?.obligationId !== expected.obligationId ||
    intent.metadata?.sourceDigest !== expected.sourceDigest
  )
    reject();
  if (intent.status !== "succeeded")
    return {
      ...observation,
      status:
        intent.status === "canceled" && session.status === "expired"
          ? "terminal_unpaid"
          : session.status === "open" && ["requires_action","requires_payment_method","requires_confirmation"].includes(intent.status)
            ? "requires_action" : "processing",
    };
  if (
    session.payment_status !== "paid" ||
    intent.amount_received !== Number(expected.amountCents) ||
    !charge ||
    identity(intent.latest_charge) !== charge.id ||
    identity(charge.payment_intent) !== intent.id ||
    charge.amount !== Number(expected.amountCents) ||
    charge.amount_captured !== Number(expected.amountCents) ||
    charge.currency !== "usd" ||
    !charge.paid ||
    !charge.captured ||
    charge.livemode !== (expected.mode === "live")
  )
    reject();
  if (
    balance &&
    (identity(charge.balance_transaction) !== balance.id ||
      identity(balance.source) !== charge.id ||
      balance.amount !== charge.amount ||
      balance.currency !== "usd" ||
      !Number.isSafeInteger(balance.fee) ||
      balance.fee < 0 ||
      balance.net !== balance.amount - balance.fee)
  )
    reject();
  return {
    status: "succeeded",
    environmentId: expected.environmentId,
    platformAccountId: expected.platformAccountId,
    livemode: expected.mode === "live",
    sessionId: session.id,
    intentId: intent.id,
    chargeId: charge.id,
    currency: "usd",
    amountCents: charge.amount,
    sourceDigest: expected.sourceDigest,
    processingFeeSource: balance ? 'succeeded_captured_original_charge_balance_v1' : null,
    actualFeeCents: balance?.fee ?? null,
    feeFactId: balance?.id ?? null,
    availableCents: balance?.status === "available" ? balance.net : null,
  };
}
export function reconcileTransfer(operation, transfer) {
  const p = operation.payload;
  if (
    !transfer ||
    transfer.amount !== Number(p.amountCents) ||
    transfer.livemode !== (p.mode === "live") ||
    transfer.currency !== p.currency ||
    identity(transfer.destination) !== p.destination ||
    identity(transfer.source_transaction) !== p.sourceCharge ||
    transfer.transfer_group !== p.transferGroup ||
    transfer.metadata?.operationId !== operation.id
  )
    reject();
  return {
    id: transfer.id,
    environmentId: operation.environment_id,
    destination: p.destination,
    sourceCharge: p.sourceCharge,
    amountCents: transfer.amount,
    currency: transfer.currency,
  };
}

export function reconcileCompensation(operation, object, balances = {}) {
  const p = operation.payload;
  if (
    !object ||
    !object.id ||
    object.amount !== Number(p.amountCents) ||
    object.currency !== "usd" ||
    (!operation.external && object.metadata?.operationId !== operation.id)
  )
    reject();
  if (["refund", "fee_restitution"].includes(operation.kind) && identity(object.charge) !== p.sourceCharge)
    reject();
  if (
    operation.kind === "reversal" &&
    identity(object.transfer) !== p.transferId
  )
    reject();
  const facts = [];
  for (const [role, b] of Object.entries(balances)) {
    if (!b) continue;
    const expectedId = identity(
      role === "original"
        ? object.balance_transaction
        : object.failure_balance_transaction,
    );
    const sign = operation.kind === "reversal" || role === "failure" ? 1 : -1;
    if (
      !["original", "failure"].includes(role) ||
      b.id !== expectedId ||
      identity(b.source) !== object.id ||
      b.currency !== "usd" ||
      b.amount !== sign * object.amount ||
      !Number.isSafeInteger(b.fee) ||
      !Number.isSafeInteger(b.net) ||
      b.net !== b.amount - b.fee ||
      !["available", "pending"].includes(b.status)
    )
      reject();
    facts.push({
      id: b.id,
      role,
      amountCents: b.amount,
      feeCents: b.fee,
      netCents: b.net,
      available: b.status === "available",
    });
  }
  return {
    id: object.id,
    environmentId: operation.environment_id,
    sourceCharge: p.sourceCharge,
    transferId: p.transferId,
    amountCents: object.amount,
    currency: "usd",
    status: operation.kind === "reversal" ? "succeeded" : object.status,
    balances: facts,
  };
}

// External provider effects carry factual scope, never a discretionary command authority.
export function reconcileExternalCompensation(
  kind,
  object,
  balances,
  expected,
) {
  if (
    !Number.isSafeInteger(object?.amount) ||
    object.amount <= 0 ||
    object.amount > Number(expected.amountCents)
  )
    reject();
  const fact = reconcileCompensation(
    {
      external: true,
      kind,
      environment_id: expected.environmentId,
      payload: {
        amountCents: object.amount,
        sourceCharge: expected.chargeId,
        transferId: expected.transferId,
      },
    },
    object,
    balances,
  );
  return {
    ...fact,
    kind,
    originalOperationId: expected.originalOperationId ?? null,
  };
}
