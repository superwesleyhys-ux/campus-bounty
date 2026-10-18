"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { useFulfillmentRequest } from "./fulfillment-request";
import { Feedback } from "./ui";
import type { Account, Agreement } from "./types";
export function AgreementCompletion({
  agreement,
  account,
  reload,
}: {
  agreement: Agreement;
  account: Account;
  reload: () => void;
}) {
  const mutation = useFulfillmentRequest(
    account.id,
    `completion:${agreement.id}`,
  );
  const [notice, setNotice] = useState("");
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice || mutation.error) status.current?.focus();
  }, [notice, mutation.error]);
  useEffect(() => {
    if (
      mutation.error instanceof ApiError &&
      [401, 403, 404].includes(mutation.error.status)
    )
      reload();
  }, [mutation.error, reload]);
  const included = agreement.milestones.filter(
    (m) => m.lifecycle !== "retired",
  );
  const eligible =
    agreement.state === "active" &&
    included.length > 0 &&
    included.every((m) => m.state === "accepted");
  if (
    account.id !== agreement.owner_id ||
    (!eligible &&
      mutation.phase !== "unknown" &&
      mutation.phase !== "sending" &&
      !notice)
  )
    return null;
  async function complete() {
    const response = await mutation.send(
      `agreements/${agreement.id}/completion`,
      {},
    );
    if (response) {
      setNotice(
        `Completion recorded. The current agreement is ${response.result.agreement.state}. No funds were transferred.`,
      );
      reload();
    }
  }
  return (
    <div className="cb-alert">
      <h2>Finish agreement</h2>
      <p>
        Every milestone has been accepted. Record fulfillment as complete. This
        does not transfer funds or record a settlement.
      </p>
      <div ref={status} tabIndex={-1}>
        <Feedback error={mutation.error} notice={notice} />
      </div>
      {mutation.phase === "unknown" && (
        <p role="alert">
          The outcome is not confirmed. Retry the same request to obtain its
          receipt.
        </p>
      )}
      {!notice && (
        <button
          className="cb-button cb-primary"
          disabled={
            mutation.phase === "loading" ||
            mutation.busy ||
            account.account_status !== "active" ||
            !account.campus_verified
          }
          onClick={() => void complete()}
        >
          {mutation.busy
            ? "Saving…"
            : mutation.phase === "unknown"
              ? "Retry completion request"
              : "Finish agreement"}
        </button>
      )}
    </div>
  );
}
