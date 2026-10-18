"use client";
import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { Feedback } from "./ui";
import { paymentIdentity, usePaymentRequest } from "./payment-request";
import {
  cents,
  reason,
  type Plan,
  type Person,
  type Funding,
  type PaymentView,
} from "./payment-model";
export type PaymentCommand = ReturnType<typeof usePaymentRequest>;
export function PaymentRecovery({
  command,
  refresh,
}: {
  command: PaymentCommand;
  refresh: () => void;
}) {
  return (
    <>
      <Feedback error={command.error} />
      {command.pending && (
        <div className="cb-alert" role="status">
          <p>
            The result of your previous request is not confirmed. Its original
            terms and request identity are saved. Checking status does not
            cancel it.
          </p>
          <button
            className="cb-button"
            disabled={command.busy}
            onClick={async () => {
              if (await command.send()) refresh();
            }}
          >
            Recover the same request
          </button>
        </div>
      )}
      <button className="cb-button" onClick={refresh} disabled={command.busy}>
        Check current payment status
      </button>
    </>
  );
}
export function ConsentButton({
  identity,
  disabled,
  label,
  onConfirm,
}: {
  identity: string;
  disabled: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [identity]);
  return (
    <fieldset disabled={disabled}>
      <label className="cb-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        I personally agree to the exact amounts and financial terms displayed
        above.
      </label>
      <button
        className="cb-button cb-primary"
        disabled={!checked}
        onClick={() => {
          setChecked(false);
          onConfirm();
        }}
      >
        {label}
      </button>
    </fieldset>
  );
}
export function MoneyPlan({
  original,
  maximum,
  people,
  account,
  historical = false,
}: {
  original: Plan;
  maximum: Plan;
  people: Person[];
  account: string;
  historical?: boolean;
}) {
  return (
    <div>
      {original.lots.map((lot, i) => (
        <div key={i}>
          <p>
            <strong>Principal {cents(lot.principalCents)}</strong> · estimated
            payer total {cents(lot.chargeTotalCents)} ·{" "}
            {historical
              ? "personally confirmed collection limit including fee reserve"
              : "upfront collection including fee reserve"}{" "}
            <strong>{cents(maximum.lots[i]?.chargeTotalCents)}</strong>
          </p>
          <ul>
            {lot.components.map((c, j) => {
              const max = maximum.lots[i]?.components.find(
                (v) =>
                  v.memberId === c.memberId &&
                  v.stagePosition === c.stagePosition,
              );
              return (
                <li key={`${c.memberId}:${c.stagePosition}:${j}`}>
                  <strong>
                    {c.memberId === account
                      ? "You"
                      : people.find((p) => p.id === c.memberId)?.name ||
                        "Recipient"}
                  </strong>{" "}
                  · stage {c.stagePosition} ·{" "}
                  {(original.members.find((m) => m.memberId === c.memberId)
                    ?.units ?? 0) / 100}
                  %<br />
                  Gross {cents(c.grossCents)} · estimated fee{" "}
                  {cents(c.recipientFeeCents)} · estimated net{" "}
                  {cents(c.netCents)}
                  <br />
                  Maximum fee {cents(max?.recipientFeeCents)} · minimum net{" "}
                  {cents(max?.netCents)}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
export function Confirmations({
  people,
  required,
  confirmed,
  account,
}: {
  people: Person[];
  required: string[];
  confirmed: string[];
  account: string;
}) {
  return (
    <ul>
      {required.map((id) => (
        <li key={id}>
          {id === account
            ? "You"
            : people.find((p) => p.id === id)?.name || "Participant"}
          :{" "}
          {confirmed.includes(id)
            ? "Personally confirmed"
            : "Personal confirmation needed"}
        </li>
      ))}
    </ul>
  );
}
export function FundingStatus({
  funding,
  people,
  account,
  feeReview,
  historicalRequirement = false,
}: {
  funding: Funding;
  people: Person[];
  account: string;
  feeReview: PaymentView["feeReview"];
  historicalRequirement?: boolean;
}) {
  return (
    <>
      <h3>Verified money status</h3>
      <dl className="cb-totals">
        {[
          [
            historicalRequirement ? "Original funding coverage" : "Funding",
            reason(funding.coverage),
          ],
          ["Received", cents(funding.receivedCents)],
          [
            historicalRequirement ? "Original quoted requirement" : "Required",
            cents(funding.requiredCents),
          ],
          ["Held available funds", cents(funding.heldCents)],
          ["Transferred to payment accounts", cents(funding.transferredCents)],
          ["Refunded", cents(funding.refundedCents)],
          ["Actual processing cost", cents(funding.actualFeeCents)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p>
        Work acceptance, payment-account transfer and bank receipt are separate.
        Bank receipt is not verified here. Held available funds exclude outbound
        reservations.
      </p>
      {funding.payees?.map((p) => (
        <p key={p.componentId}>
          <strong>
            {p.memberId === account
              ? "You"
              : people.find((v) => v.id === p.memberId)?.name || "Recipient"}
          </strong>
          : gross {cents(p.grossCents)}, fee {cents(p.feeCents)}, net{" "}
          {cents(p.netCents)}.{" "}
          {p.releaseReady
            ? "Eligible for release"
            : "Awaiting release eligibility"}
          ; transfer {reason(p.transferStatus)}; transferred{" "}
          {cents(p.transferredCents)}. Recipient transfers:{" "}
          {p.transferCapability || "unknown"}.
        </p>
      ))}
      {funding.feePlan && !feeReview?.isCurrentEvidence && (
        <p>
          Unused payer reserve owed back:{" "}
          {cents(funding.feePlan.payerRestitutionCents)} · source restitution{" "}
          {reason(funding.feePlan.restitutionStatus)}.
        </p>
      )}
      {funding.blockedReasons.some(
        (r) => !feeReview?.initialQuoteBlockers.includes(r),
      ) && (
        <ul className="cb-alert">
          {funding.blockedReasons
            .filter((r) => !feeReview?.initialQuoteBlockers.includes(r))
            .map((r, i) => (
              <li key={`${r}:${i}`}>{reason(r)}</li>
            ))}
        </ul>
      )}
      {feeReview && (
        <section aria-label="Current processing fee review">
          <h3>Current processing fee review</h3>
          <p>
            {reason(feeReview.state)} ·{" "}
            {feeReview.isCurrentEvidence
              ? "Current verified fee"
              : "Current fee evidence needs review"}
            :{" "}
            {feeReview.isCurrentEvidence
              ? cents(feeReview.settledActualFeeCents)
              : "Not yet confirmed"}
            .
          </p>
          {feeReview.restitutions.map((r, i) => (
            <p key={i}>
              Unused fee reserve from {r.source} payment: {cents(r.amountCents)}{" "}
              · source refund {reason(r.status)}.
            </p>
          ))}
          {feeReview.initialQuoteBlockers.length > 0 && (
            <details>
              <summary>Original collection history</summary>
              <p>
                The original payment succeeded. Its initial quote is not
                reusable after the separately confirmed fee revision. Original
                fee reserve: {cents(funding.feePlan?.payerRestitutionCents)};
                its initial settlement record is{" "}
                {reason(funding.feePlan?.restitutionStatus ?? "unknown")}.
                Current source refunds are shown above.
              </p>
              {feeReview.initialQuoteBlockers.map((r) => (
                <p key={r}>Initial collection only: {reason(r)}.</p>
              ))}
            </details>
          )}
        </section>
      )}
    </>
  );
}
export function HostedAction({
  account,
  path,
  label,
  nestedAttempt = false,
}: {
  account: string;
  path: string;
  label: string;
  nestedAttempt?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => {
      controller.current?.abort();
      setBusy(false);
      setError(null);
    };
    const changed = (e: StorageEvent) => {
      if (e.key === "campus:auth-version") clear();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("campus:session-expired", clear);
    return () => {
      clear();
      window.removeEventListener("storage", changed);
      window.removeEventListener("campus:session-expired", clear);
    };
  }, [account, path]);
  return (
    <>
      <button
        className="cb-button cb-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          controller.current?.abort();
          const ctrl = new AbortController();
          controller.current = ctrl;
          try {
            await paymentIdentity(account, ctrl.signal);
            const v = await request<{
              hostedUrl: string | null;
              attempt?: { hostedUrl: string | null };
            }>(path, { signal: ctrl.signal });
            await paymentIdentity(account, ctrl.signal);
            if (ctrl.signal.aborted) return;
            const hostedUrl = nestedAttempt
              ? v.attempt?.hostedUrl
              : v.hostedUrl;
            if (!hostedUrl)
              throw Error(
                "The hosted link is not available or has expired. Refresh status and request a new link where offered.",
              );
            const u = new URL(hostedUrl);
            if (
              u.protocol !== "https:" ||
              !["checkout.stripe.com", "connect.stripe.com"].includes(
                u.hostname,
              )
            )
              throw Error(
                "The payment service returned an unsupported hosted link.",
              );
            window.location.assign(hostedUrl);
          } catch (e) {
            if (!ctrl.signal.aborted) {
              setError(e as Error);
              setBusy(false);
            }
          }
        }}
      >
        {busy ? "Checking your current link…" : label}
      </button>
      <Feedback error={error} />
    </>
  );
}
