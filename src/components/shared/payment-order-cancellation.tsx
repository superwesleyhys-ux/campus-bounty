"use client";
import { useMutation } from "./api";
import { ConfirmAction } from "./confirm-action";
import { Feedback } from "./ui";
import type { PaymentView } from "./payment-model";
import type { PaymentCommand } from "./payment-presentation";

export function OrderPaymentCancellation({
  account,
  id,
  policy,
  command,
  cancel,
  onChanged,
}: {
  account: string;
  id: string;
  policy: PaymentView["orderPolicy"];
  command: PaymentCommand;
  onChanged: () => void;
  cancel: (
    path: string,
    body: Record<string, unknown>,
    expected?: Record<string, unknown>,
    required?: string[],
  ) => Promise<unknown>;
}) {
  const legacy = useMutation(account);
  return (
    <>
      <ConfirmAction
        headingLevel={3}
        cancelLabel="Keep reservation"
        label="Cancel reservation"
        confirmLabel="Confirm cancellation"
        description="Request cancellation. Payment attempts must be resolved before inventory can return; already received or late money may remain held for review."
        busy={command.busy || legacy.busy}
        disabled={command.blocked || !policy}
        onConfirm={async () => {
          if (!policy) return false;
          if (policy.paymentRevision > 0)
            return !!(await cancel(
              `orders/${id}/cancellation`,
              {
                expectedPaymentRevision: policy.paymentRevision,
                orderTermsDigest: policy.orderTermsDigest,
              },
              { orderId: id },
              ["state", "resolution"],
            ));
          // Before financial preparation, the original reservation command remains valid.
          // Its server guard rejects a concurrent payment attempt instead of bypassing revision consent.
          const result = await legacy.run(
            `orders/${id}/cancellation`,
            {},
            "Cancellation requested. Check current reservation and payment status.",
          );
          if (result) onChanged();
          return !!result;
        }}
      />
      <Feedback {...legacy} />
    </>
  );
}
