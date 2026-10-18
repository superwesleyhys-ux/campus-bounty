"use client";
import { ReleaseChoice, type ReleasePolicy } from "./transaction-terms";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, useResource } from "./api";
import { Field, Feedback, ResourceState } from "./ui";
import { categories, money, type Account, type Product } from "./types";
import {
  currentTerms,
  listingPath,
  type Listing,
  type ListingKind,
  type ListingTerms,
  type ListingReceipt,
  type CommandResult,
} from "./listing-types";
import { TermsComparison, TermsView } from "./listing-terms";
import { useListingRequest } from "./listing-request";
import { dollarsToCents } from "@/lib/shared-input.mjs";
import { validateTaskTerms } from "@/lib/task-terms.mjs";
type Row = {
  key: string;
  title: string;
  amount: string;
  deliverable: string;
  acceptanceCriteria: string;
};
type Draft = {
  title: string;
  description: string;
  category: string;
  amount: string;
  dueDate: string;
  releasePolicy: string;
  stock: string;
  pickup: boolean;
  shipping: boolean;
  shippingAmount: string;
  milestones: Row[];
};
function draftOf(row: Listing): Draft {
  const t = currentTerms(row);
  return {
    title: t.title,
    description: t.description,
    category: "category" in t ? t.category : "Research",
    amount: String(("rewardCents" in t ? t.rewardCents : t.priceCents) / 100),
    dueDate: "dueDate" in t ? t.dueDate || "" : "",
    releasePolicy: "releasePolicy" in t ? t.releasePolicy || "" : "",
    stock: "stock" in t ? String(t.stock) : "0",
    pickup:
      "deliveryMethods" in t ? t.deliveryMethods.includes("pickup") : true,
    shipping:
      "deliveryMethods" in t ? t.deliveryMethods.includes("shipping") : false,
    shippingAmount: "shippingCents" in t ? String(t.shippingCents / 100) : "0",
    milestones:
      "milestones" in t
        ? t.milestones.map((m) => ({
            key: crypto.randomUUID(),
            title: m.title,
            amount: String(m.amountCents / 100),
            deliverable: m.deliverable,
            acceptanceCriteria: m.acceptanceCriteria || "",
          }))
        : [],
  };
}
function termsOf(d: Draft, kind: ListingKind): ListingTerms {
  if (!d.title.trim() || !d.description.trim())
    throw Error("Title and description are required.");
  const amount = dollarsToCents(d.amount);
  if (kind === "product") {
    if (!d.pickup && !d.shipping)
      throw Error("Choose at least one delivery method.");
    const stock = Number(d.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100000)
      throw Error(
        "Available quantity must be a whole number from 0 to 100000.",
      );
    return {
      title: d.title,
      description: d.description,
      priceCents: amount,
      stock,
      deliveryMethods: [
        ...(d.pickup ? ["pickup"] : []),
        ...(d.shipping ? ["shipping"] : []),
      ],
      shippingCents: d.shipping
        ? dollarsToCents(d.shippingAmount, { zero: true, max: 10000000 })
        : 0,
    };
  }
  validateTaskTerms(d.dueDate, d.milestones);
  const milestones = d.milestones.map((m) => ({
    title: m.title,
    deliverable: m.deliverable,
    acceptanceCriteria: m.acceptanceCriteria,
    amountCents: dollarsToCents(m.amount),
  }));
  if (milestones.some((m) => !m.title.trim() || !m.deliverable.trim()))
    throw Error("Every milestone needs a title and deliverable.");
  if (milestones.reduce((s, m) => s + m.amountCents, 0) !== amount)
    throw Error("Milestone rewards must equal the total bounty reward.");
  return {
    title: d.title,
    description: d.description,
    category: d.category,
    rewardCents: amount,
    dueDate: d.dueDate,
    ...(d.releasePolicy
      ? { releasePolicy: d.releasePolicy as ReleasePolicy }
      : {}),
    milestones,
  };
}
export function ListingEditor({
  id,
  kind,
  account,
}: {
  id: string;
  kind: ListingKind;
  account: Account;
}) {
  const data = useResource<Listing>(listingPath(kind, id));
  if (!data.data || data.error) return <ResourceState {...data} />;
  const row = data.data;
  if (!account.campus_verified || account.account_status !== "active")
    return (
      <p role="alert">
        Current campus verification and an active account are required to edit.
        Existing history remains available in Workspace.
      </p>
    );
  if (("owner_id" in row ? row.owner_id : row.seller_id) !== account.id)
    return <p role="alert">Only the owner can edit this listing.</p>;
  return (
    <Editor
      key={`${account.id}:${kind}:${id}`}
      row={row}
      kind={kind}
      account={account}
      reload={data.reload}
    />
  );
}
function Editor({
  row,
  kind,
  account,
  reload,
}: {
  row: Listing;
  kind: ListingKind;
  account: Account;
  reload: () => void;
}) {
  const capabilities = useResource<{ transactionTerms: boolean }>(
    "capabilities",
  );
  const router = useRouter(),
    query = useSearchParams(),
    path = listingPath(kind, row.id),
    storage = `campus:listing-draft:${account.id}:${kind}:${row.id}`;
  const [base, setBase] = useState(row),
    [draft, setDraft] = useState<Draft>(() => draftOf(row)),
    [ready, setReady] = useState(false),
    [review, setReview] = useState<ListingTerms | null>(null),
    [error, setError] = useState<Error | null>(null),
    [cancel, setCancel] = useState(false),
    [notice, setNotice] = useState(""),
    [latest, setLatest] = useState<Listing | null>(null);
  const heading = useRef<HTMLHeadingElement>(null),
    cancelButton = useRef<HTMLButtonElement>(null),
    command = useListingRequest<CommandResult<ListingReceipt, Listing>>(
      `${account.id}:${kind}:${row.id}:edit`,
    );
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storage) || "null");
      if (
        saved?.base?.id === row.id &&
        saved?.draft?.milestones &&
        typeof saved.draft.title === "string"
      ) {
        setBase(saved.base);
        setDraft(saved.draft);
        setNotice("Your saved draft has been restored.");
      }
    } catch {}
    setReady(true);
  }, [storage, row.id]);
  useEffect(() => {
    if (ready) {
      try {
        localStorage.setItem(storage, JSON.stringify({ base, draft }));
      } catch {
        setNotice("Draft storage unavailable. Keep this page open.");
      }
    }
  }, [base, draft, ready, storage]);
  useEffect(() => {
    if (review || error || cancel || command.error || command.result)
      heading.current?.focus();
  }, [review, error, cancel, command.error, command.result]);
  function leave() {
    const q = new URLSearchParams(query.toString());
    q.delete("edit");
    router.push(`/?${q}#listing-management`);
  }
  function update(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
    setNotice("Draft saved on this device for your account.");
  }
  const conflict =
    command.error instanceof ApiError &&
    ["stale_revision", "stock_changed", "state_conflict"].includes(
      command.error.code,
    );
  const frozen = command.busy || !!command.pending;
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({
      ...draftOf(base),
      milestones: draftOf(base).milestones.map((m, i) => ({
        ...m,
        key: draft.milestones[i]?.key || m.key,
      })),
    });
  async function save() {
    if (!review && !command.pending) return;
    const result = await command.send(`${path}/edit`, {
      expectedRevision: base.revision,
      ...(kind === "product"
        ? {
            expectedStock: (base as Product).stock,
            expectedStockRevision: (base as Product).stock_revision,
          }
        : {}),
      terms: review,
    });
    if (result) {
      setReview(null);
      setLatest(null);
      reload();
      try {
        localStorage.removeItem(storage);
      } catch {}
    }
  }
  if (!ready || !command.ready)
    return <p role="status">Opening listing draft…</p>;
  const sum = draft.milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  return (
    <section className="cb-compose">
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">
            Version {base.terms_version} · revision {base.revision}
          </span>
          <h1>{kind === "task" ? "Edit bounty" : "Edit listing"}</h1>
        </div>
        <button
          ref={cancelButton}
          className="cb-button"
          disabled={frozen}
          onClick={() => (dirty ? setCancel(true) : leave())}
        >
          Cancel editing
        </button>
      </div>
      <h2 ref={heading} tabIndex={-1}>
        {command.result
          ? "Changes saved"
          : command.pending
            ? "Resolve previous save"
            : cancel
              ? "Discard this draft?"
              : review
                ? "Review changes"
                : "Listing details"}
      </h2>
      <Feedback error={error || command.error} />
      <p className="cb-fine">
        {notice ||
          "Edits are saved locally until you review and save a new version."}
      </p>
      {command.result ? (
        <section className="cb-panel">
          <p role="status">
            {command.result.replayed ? "Recovered original receipt" : "Saved"}:
            version {command.result.receipt.termsVersion}, revision{" "}
            {command.result.receipt.revision}. Current listing: version{" "}
            {command.result.current.terms_version}, revision{" "}
            {command.result.current.revision},{" "}
            {command.result.current.visibility}.
          </p>
          <p>Signed agreements and existing orders keep their terms.</p>
          <button className="cb-button cb-primary" onClick={leave}>
            Return to listing
          </button>
        </section>
      ) : (
        <>
          {cancel && (
            <div className="cb-alert">
              <p>Discard the local draft and return to this listing?</p>
              <button
                className="cb-button"
                onClick={() => {
                  setCancel(false);
                  cancelButton.current?.focus();
                }}
              >
                Keep editing
              </button>
              <button
                className="cb-button"
                onClick={() => {
                  try {
                    localStorage.removeItem(storage);
                  } catch {}
                  leave();
                }}
              >
                Discard changes
              </button>
            </div>
          )}
          {command.pending && !command.busy && (
            <div className="cb-alert">
              <p>
                The previous save may have completed. Your original request is
                preserved. Recover its receipt before editing again.
              </p>
              <button
                className="cb-button cb-primary"
                onClick={() => void save()}
              >
                Check save / recover receipt
              </button>
            </div>
          )}
          {conflict && (
            <section className="cb-panel">
              <h3>Keep your draft and review current values</h3>
              <p>{command.error?.message} Your draft has not been replaced.</p>
              <button
                className="cb-button"
                onClick={async () => {
                  const { request } = await import("./api");
                  try {
                    setLatest(await request<Listing>(path));
                  } catch (e) {
                    setError(e as Error);
                  }
                }}
              >
                Load current saved values
              </button>
              {latest && (
                <>
                  <TermsView terms={currentTerms(latest)} />
                  <p>
                    Revision {latest.revision}
                    {"stock_revision" in latest
                      ? ` · inventory revision ${latest.stock_revision}`
                      : ""}
                  </p>
                  <button
                    className="cb-button"
                    onClick={() => {
                      setBase(latest);
                      setLatest(null);
                      setReview(null);
                      command.clear();
                    }}
                  >
                    Use this baseline and keep my draft
                  </button>
                </>
              )}
            </section>
          )}
          {review ? (
            <section className="cb-panel">
              <TermsComparison before={currentTerms(base)} after={review} />
              <p className="cb-alert">
                Saving creates a new immutable version. Active applicants must
                review it and receive a fresh invitation. Signed agreements and
                existing orders keep their original terms. Reserved orders
                remain reserved.
              </p>
              <div className="cb-actions">
                <button
                  className="cb-button"
                  disabled={frozen}
                  onClick={() => setReview(null)}
                >
                  Back to editing
                </button>
                <button
                  className="cb-button cb-primary"
                  disabled={frozen || conflict}
                  onClick={() => void save()}
                >
                  {command.busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </section>
          ) : (
            <form
              className="cb-panel"
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  setReview(termsOf(draft, kind));
                  setError(null);
                } catch (e) {
                  setError(e as Error);
                }
              }}
            >
              <fieldset disabled={frozen || conflict}>
                <legend>Required listing details</legend>
                <Field label="Title">
                  <input
                    required
                    maxLength={160}
                    value={draft.title}
                    onChange={(e) => update({ title: e.target.value })}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    required
                    maxLength={10000}
                    rows={5}
                    value={draft.description}
                    onChange={(e) => update({ description: e.target.value })}
                  />
                </Field>
                {kind === "task" && (
                  <Field label="Category">
                    <select
                      value={draft.category}
                      onChange={(e) => update({ category: e.target.value })}
                    >
                      {categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field
                  label={
                    kind === "task"
                      ? "Total bounty reward (USD)"
                      : "Price per item (USD)"
                  }
                >
                  <input
                    required
                    inputMode="decimal"
                    value={draft.amount}
                    onChange={(e) => update({ amount: e.target.value })}
                  />
                </Field>
                {kind === "task" ? (
                  <>
                    <Field label="Target delivery date">
                      <input
                        required
                        type="date"
                        min="1000-01-01"
                        max="9999-12-31"
                        value={draft.dueDate}
                        onChange={(e) => update({ dueDate: e.target.value })}
                      />
                    </Field>
                    <h3>Milestones</h3>
                    <p>
                      Milestone total: {money(Math.round(sum * 100))} · Bounty
                      reward: {draft.amount ? `$${draft.amount}` : "Not set"}
                      {Math.round(sum * 100) !==
                      Math.round(Number(draft.amount) * 100)
                        ? " — amounts must match"
                        : ""}
                    </p>
                    {capabilities.data?.transactionTerms && (
                      <ReleaseChoice
                        legacy
                        value={draft.releasePolicy}
                        onChange={(releasePolicy) => update({ releasePolicy })}
                      />
                    )}
                    {draft.milestones.map((m, i) => (
                      <fieldset key={m.key}>
                        <legend>Milestone {i + 1}</legend>
                        {(
                          [
                            "title",
                            "deliverable",
                            "acceptanceCriteria",
                            "amount",
                          ] as const
                        ).map((k) => (
                          <Field
                            key={k}
                            label={
                              k === "title"
                                ? "Milestone title"
                                : k === "amount"
                                  ? "Milestone reward (USD)"
                                  : k === "deliverable"
                                    ? "Expected deliverable"
                                    : "Acceptance criteria"
                            }
                          >
                            {k === "deliverable" ||
                            k === "acceptanceCriteria" ? (
                              <textarea
                                required
                                maxLength={10000}
                                rows={3}
                                value={m[k]}
                                onChange={(e) =>
                                  update({
                                    milestones: draft.milestones.map((v) =>
                                      v.key === m.key
                                        ? { ...v, [k]: e.target.value }
                                        : v,
                                    ),
                                  })
                                }
                              />
                            ) : (
                              <input
                                required
                                maxLength={k === "title" ? 160 : 12}
                                inputMode={k === "amount" ? "decimal" : "text"}
                                value={m[k]}
                                onChange={(e) =>
                                  update({
                                    milestones: draft.milestones.map((v) =>
                                      v.key === m.key
                                        ? { ...v, [k]: e.target.value }
                                        : v,
                                    ),
                                  })
                                }
                              />
                            )}
                          </Field>
                        ))}
                        <button
                          type="button"
                          className="cb-button"
                          disabled={draft.milestones.length === 1}
                          onClick={() =>
                            update({
                              milestones: draft.milestones.filter(
                                (v) => v.key !== m.key,
                              ),
                            })
                          }
                        >
                          Remove milestone {i + 1}
                        </button>
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      className="cb-button"
                      disabled={draft.milestones.length >= 20}
                      onClick={() =>
                        update({
                          milestones: [
                            ...draft.milestones,
                            {
                              key: crypto.randomUUID(),
                              title: "",
                              deliverable: "",
                              acceptanceCriteria: "",
                              amount: "",
                            },
                          ],
                        })
                      }
                    >
                      Add milestone
                    </button>
                  </>
                ) : (
                  <>
                    <Field
                      label="Available quantity"
                      help="Available units only. Existing reserved orders keep their inventory obligation."
                    >
                      <input
                        type="number"
                        required
                        min={0}
                        max={100000}
                        step={1}
                        value={draft.stock}
                        onChange={(e) => update({ stock: e.target.value })}
                      />
                    </Field>
                    <label className="cb-check">
                      <input
                        type="checkbox"
                        checked={draft.pickup}
                        onChange={(e) => update({ pickup: e.target.checked })}
                      />
                      Campus pickup
                    </label>
                    <label className="cb-check">
                      <input
                        type="checkbox"
                        checked={draft.shipping}
                        onChange={(e) => update({ shipping: e.target.checked })}
                      />
                      U.S. shipping
                    </label>
                    {draft.shipping && (
                      <Field label="Shipping per order (USD)">
                        <input
                          required
                          inputMode="decimal"
                          value={draft.shippingAmount}
                          onChange={(e) =>
                            update({ shippingAmount: e.target.value })
                          }
                        />
                      </Field>
                    )}
                  </>
                )}
                <button className="cb-button cb-primary" type="submit">
                  Review changes
                </button>
              </fieldset>
            </form>
          )}
        </>
      )}
    </section>
  );
}
