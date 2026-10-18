"use client";
import { usePaymentRequest } from "./payment-request";
import { PaymentRecovery } from "./payment-presentation";
import { useEffect, useState } from "react";
import { ApiError, useResource } from "./api";
import { useListingRequest } from "./listing-request";
import { Feedback, ResourceState } from "./ui";
import { money, type Account } from "./types";
export type ReleasePolicy = "per_milestone" | "final_completion";
export function ReleaseDisclosure({ policy }: { policy?: string | null }) {
  return (
    <div className="cb-panel">
      <p>
        <strong>Release policy:</strong>{" "}
        {policy === "per_milestone"
          ? "After each accepted milestone"
          : policy === "final_completion"
            ? "After final completion"
            : "Not recorded — no historical choice inferred"}
      </p>
      {policy && (
        <>
          <p>
            The full reward must be funded upfront in either mode. Acceptance
            alone does not move funds.
          </p>
          <p>
            Platform service fee: $0. Processing fees: 50% publisher / 50%
            recipients, with the recipients’ half following their confirmed
            reward proportions. The publisher pays the odd fee cent.
          </p>
        </>
      )}
    </div>
  );
}
export function ReleaseChoice({
  value,
  onChange,
  disabled = false,
  legacy = false,
}: {
  value: string;
  onChange: (s: ReleasePolicy) => void;
  disabled?: boolean;
  legacy?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>When should accepted work be released?</legend>
      {legacy && !value && (
        <p>
          No release policy was recorded. Choosing one creates new terms
          requiring fresh consent.
        </p>
      )}
      {(["per_milestone", "final_completion"] as const).map((v) => (
        <label className="cb-check" key={v}>
          <input
            type="radio"
            name="release-policy"
            value={v}
            checked={value === v}
            onChange={() => onChange(v)}
          />
          {v === "per_milestone"
            ? "After each accepted milestone"
            : "After final completion"}
        </label>
      ))}
      <ReleaseDisclosure policy={value} />
    </fieldset>
  );
}
type Component = {
  memberId: string;
  stagePosition: number;
  grossCents: number;
  recipientFeeCents: number | null;
  netCents: number | null;
};
type PolicyText = {
  policyId: string;
  version: string;
  title: string;
  description: string;
};
type PolicySnapshot = {
  policyId: string;
  provenance: string;
  payload: {
    disclosure: {
      format: string;
      feeAdjustment: PolicyText;
      tax: PolicyText;
      refund: PolicyText;
    };
  };
};
type Revision = {
  id: string;
  revision: number;
  listing_version: number;
  task_revision: number;
  policy_id: string | null;
  policy_snapshot: PolicySnapshot | null;
  digest: string;
  ratios: { memberId: string; units: number }[];
  plan: {
    lots: {
      principalCents: number;
      estimatedProcessorFeeCents: number | null;
      publisherProcessorFeeCents: number | null;
      chargeTotalCents: number | null;
      components: Component[];
    }[];
  };
};
type Allocation = {
  applicationId: string;
  applicantId: string;
  publisherId: string;
  state: string;
  releasePolicy: string | null;
  termsVersion: number;
  taskRevision: number;
  members: { user_id: string; display_name: string }[];
  current: Revision | null;
  history: Revision[];
  historyNext: number | null;
  confirmations: {
    allocation_id: string;
    user_id: string;
    consent_kind: string;
  }[];
  policies: {
    id: string;
    status: string;
    disclosure_ready: boolean;
    provenance: string;
    payload: {
      feeAdjustmentPolicyId?: string;
      taxPolicyId?: string;
      refundPolicyId?: string;
    };
  }[];
  blockedReasons: string[];
  financialConsentAvailable: boolean;
};
export function TransactionAllocation({
  id,
  account,
}: {
  id: string;
  account: Account;
}) {
  const c = useResource<{ transactionTerms: boolean }>("capabilities");
  if (!c.data?.transactionTerms) return null;
  return (
    <AllocationEditor key={`${account.id}:${id}`} id={id} account={account} />
  );
}
function AllocationEditor({ id, account }: { id: string; account: Account }) {
  const preparation=usePaymentRequest(account.id,`application-preparation:${id}`);
  const [beforeRevision, setBeforeRevision] = useState<number | null>(null);
  const resource = useResource<Allocation>(
      `applications/${id}/allocations${beforeRevision ? `?beforeRevision=${beforeRevision}` : ""}`,
    ),
    command = useListingRequest<{
      receipt: { id: string };
      replayed: boolean;
      current: Allocation;
    }>(`${account.id}:allocation:${id}`);
  const [units, setUnits] = useState<Record<string, string>>({}),
    [checked, setChecked] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [dirty, setDirty] = useState(false);
  const storage = `campus:allocation-draft:${account.id}:${id}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storage) || "null");
      if (saved && typeof saved === "object") {
        setUnits(saved);
        setDirty(true);
      }
    } catch {}
  }, [storage]);
  const d = resource.data;
  useEffect(() => {
    setChecked(false);
    if (d && !dirty)
      setUnits(
        Object.fromEntries(
          d.members.map((m) => [
            m.user_id,
            d.current?.ratios.find((r) => r.memberId === m.user_id)
              ? String(
                  d.current.ratios.find((r) => r.memberId === m.user_id)!
                    .units / 100,
                )
              : d.members.length === 1
                ? "100"
                : "",
          ]),
        ),
      );
  }, [d, dirty]);
  if (!d) return <ResourceState {...resource} />;
  if (!d.releasePolicy) return <ReleaseDisclosure />;
  const r = d.current,
    owner = d.applicantId === account.id,
    active = ["applied", "invited"].includes(d.state),
    stale = command.error instanceof ApiError && command.error.status === 409;
  const frozen = command.busy || !!command.pending || !command.ready;
  const policy =
    d.policies.find((p) => p.status === "approved" && p.disclosure_ready)?.id ??
    null;
  const disclosureUnavailable = !!r?.policy_id && !d.financialConsentAvailable;
  async function send(confirm: boolean) {
    if (!d) return;
    setError(null);
    try {
      if (command.pending) {
        const result = await command.send(
          command.pending.path,
          command.pending.body,
        );
        if (result) {
          setChecked(false);
          setDirty(false);
          try {
            localStorage.removeItem(storage);
          } catch {}
          resource.reload();
        }
        return;
      }
      const path = `applications/${id}/allocations${confirm ? `/${r?.revision}/confirmations` : ""}`;
      let body: unknown;
      if (confirm) {
        if (!r) return;
        body = {
          expectedRevision: d.taskRevision,
          expectedTermsVersion: d.termsVersion,
          allocationDigest: r.digest,
        };
      } else {
        const ratios = d.members.map((m) => ({
          userId: m.user_id,
          ratioUnits: Math.round(Number(units[m.user_id]) * 100),
        }));
        if (
          ratios.some(
            (v) =>
              !/^\d+(\.\d{1,2})?$/.test(units[v.userId] || "") ||
              !Number.isInteger(v.ratioUnits) ||
              v.ratioUnits <= 0,
          ) ||
          ratios.reduce((s, v) => s + v.ratioUnits, 0) !== 10000
        )
          throw Error(
            "Enter percentages with up to two decimal places totaling 100%.",
          );
        body = {
          expectedTermsVersion: d.termsVersion,
          expectedRevision: d.taskRevision,
          expectedAllocationRevision: r?.revision ?? 0,
          ratios,
          ratioDenominator: 10000,
          policyVersionId: policy,
        };
      }
      const result = await command.send(path, body);
      if (result) {
        setChecked(false);
        setDirty(false);
        try {
          localStorage.removeItem(storage);
        } catch {}
        resource.reload();
      }
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <section className="cb-panel" aria-label="Transaction allocation">
      <h3>Recipient allocation and financial consent</h3>
      <ReleaseDisclosure policy={d.releasePolicy} />
      {active && <><button className="cb-button" disabled={preparation.blocked || frozen} onClick={async()=>{if(await preparation.send(`applications/${id}/payment-preparation`,{},{resourceId:id},["policyVersionId","policyDigest"]))resource.reload();}}>Prepare approved current financial terms</button><PaymentRecovery command={preparation} refresh={resource.reload}/></>}
      <p>
        Listing version {d.termsVersion} · allocation revision{" "}
        {r?.revision ?? "not proposed"}. Listing acknowledgement is separate
        from this confirmation.
      </p>
      {owner && active && (
        <fieldset disabled={frozen || stale}>
          <legend>Draft new reward proportions</legend>
          <p>
            Percentages must total 100%. Each recipient confirms personally; the
            captain cannot confirm for another member. Editing this draft does
            not change the saved revision below.
          </p>
          {d.members.map((m) => (
            <label className="cb-field" key={m.user_id}>
              {m.display_name} percentage
              <input
                aria-label={`${m.display_name} percentage`}
                inputMode="numeric"
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                value={units[m.user_id] ?? ""}
                onChange={(e) => {
                  const next = { ...units, [m.user_id]: e.target.value };
                  setUnits(next);
                  setDirty(true);
                  try {
                    localStorage.setItem(storage, JSON.stringify(next));
                  } catch {}
                }}
              />
            </label>
          ))}
          <button className="cb-button" onClick={() => void send(false)}>
            Propose allocation revision
          </button>
        </fieldset>
      )}
      {r && (
        <>
          <p>
            Any leftover reward cents are assigned consistently among
            recipients; your exact rounded amounts are shown below. The
            publisher pays the odd processing fee cent. These amounts are
            estimates, not paid funds.
          </p>
          <section
            aria-label="Saved allocation proportions"
            className="cb-panel"
          >
            <h4>Saved revision {r.revision}: proportions you are confirming</h4>
            <ul>
              {r.ratios.map((ratio) => (
                <li key={ratio.memberId}>
                  {d.members.find((m) => m.user_id === ratio.memberId)
                    ?.display_name || "Recipient"}
                  : {ratio.units / 100}%
                </li>
              ))}
            </ul>
            <p>
              Confirmation applies only to this saved revision. Unsaved draft
              edits above are not included.
            </p>
          </section>
          {r.policy_id &&
            (d.financialConsentAvailable && r.policy_snapshot ? (
              <section aria-label="Saved financial policy" className="cb-alert">
                <h4>
                  Financial conditions included in saved revision {r.revision}
                </h4>
                <p>
                  <strong>Approved estimate source:</strong>{" "}
                  {r.policy_snapshot.provenance}
                </p>
                {(["feeAdjustment", "tax", "refund"] as const).map((kind) => {
                  const terms = r.policy_snapshot!.payload.disclosure[kind];
                  return (
                    <div key={kind}>
                      <h5>
                        {terms.title} · version {terms.version}
                      </h5>
                      <p>{terms.description}</p>
                    </div>
                  );
                })}
                <p>
                  An estimate is not an actual processing cost. This
                  confirmation does not authorize additional charges, deductions
                  or refunds.
                </p>
              </section>
            ) : (
              <p role="status">
                Readable financial policy terms are unavailable for this saved
                revision. Financial confirmation is blocked; a new fully
                disclosed revision is required.
              </p>
            ))}
          {r.plan.lots.map((lot, i) => (
            <div key={i}>
              <p>
                Reward gross: {money(lot.principalCents)} · estimated processing
                fee:{" "}
                {lot.estimatedProcessorFeeCents === null
                  ? "Pending trusted estimate"
                  : money(lot.estimatedProcessorFeeCents)}{" "}
                · publisher total:{" "}
                {lot.chargeTotalCents === null
                  ? "Pending"
                  : money(lot.chargeTotalCents)}
              </p>
              <ul>
                {lot.components.map((c) => (
                  <li key={`${c.memberId}:${c.stagePosition}`}>
                    {d.members.find((m) => m.user_id === c.memberId)
                      ?.display_name || "Recipient"}{" "}
                    · stage {c.stagePosition}: gross {money(c.grossCents)} / fee{" "}
                    {c.recipientFeeCents === null
                      ? "Pending"
                      : money(c.recipientFeeCents)}{" "}
                    / net {c.netCents === null ? "Pending" : money(c.netCents)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ul>
            {[
              ...d.members,
              { user_id: d.publisherId, display_name: "Publisher" },
            ].map((m) => (
              <li key={m.user_id}>
                {m.display_name}:{" "}
                {d.confirmations.some(
                  (c) => c.allocation_id === r.id && c.user_id === m.user_id,
                )
                  ? "Confirmed this revision"
                  : "Confirmation required"}
              </li>
            ))}
          </ul>
          {active && (
            <>
              <label className="cb-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={frozen || stale || disclosureUnavailable}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                {r.policy_id
                  ? `I confirm saved revision ${r.revision}, including its displayed percentages, exact financial terms and policy descriptions.`
                  : `I confirm saved revision ${r.revision} and its displayed percentages only. Fee and net amounts remain pending; this is not executable financial consent.`}
              </label>
              <button
                className="cb-button"
                disabled={!checked || frozen || stale || disclosureUnavailable}
                onClick={() => void send(true)}
              >
                {r.policy_id
                  ? "Confirm financial terms"
                  : "Confirm ratios only"}
              </button>
            </>
          )}
        </>
      )}
      {d.blockedReasons.length > 0 && (
        <p role="status">
          Acceptance blocked:{" "}
          {d.blockedReasons.map((s) => s.replaceAll("_", " ")).join("; ")}. Fee
          adjustments, refunds and tax require an approved policy.
        </p>
      )}
      <Feedback error={error || command.error} />
      {command.result && (
        <p role="status">
          {command.result.replayed
            ? "Recovered original receipt"
            : "Saved exact revision"}
        </p>
      )}
      {command.pending && !command.busy && (
        <button
          className="cb-button"
          onClick={() =>
            void send(command.pending!.path.endsWith("/confirmations"))
          }
        >
          Recover previous allocation request
        </button>
      )}
      <button
        className="cb-button"
        disabled={frozen}
        onClick={() => {
          setChecked(false);
          command.clear();
          resource.reload();
        }}
      >
        Refresh allocation and review stale terms
      </button>
      <details>
        <summary>Immutable allocation history ({d.history.length})</summary>
        {d.history.map((v) => (
          <p key={v.id}>
            Revision {v.revision} · listing {v.listing_version} ·{" "}
            {d.confirmations.filter((c) => c.allocation_id === v.id).length}{" "}
            confirmations ·{" "}
            {v.policy_id ? "Exact financial estimate" : "Ratios only"}
          </p>
        ))}
        {d.historyNext && (
          <button
            className="cb-button"
            onClick={() => setBeforeRevision(d.historyNext)}
          >
            Older allocation history
          </button>
        )}
        {beforeRevision && (
          <button className="cb-button" onClick={() => setBeforeRevision(null)}>
            Latest allocation history
          </button>
        )}
      </details>
    </section>
  );
}
