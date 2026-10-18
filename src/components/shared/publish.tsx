"use client";
import { useEffect, useRef, useState } from "react";
import { ReleaseChoice, ReleaseDisclosure } from "./transaction-terms";
import { useMutation, useResource } from "./api";
import { categories, money, type Account } from "./types";
import { Feedback, Field, PendingButton } from "./ui";
import { dollarsToCents } from "@/lib/shared-input.mjs";
import {
  formatDueDate,
  isCalendarDate,
  validateTaskTerms,
} from "@/lib/task-terms.mjs";

const initial = {
  title: "",
  description: "",
  category: "Research",
  amount: "",
  stock: "1",
  pickup: true,
  shipping: false,
  shippingAmount: "0",
  dueDate: "",
  releasePolicy: "",
  milestones: [
    { title: "", amount: "", deliverable: "", acceptanceCriteria: "" },
  ],
};
export function Publish({
  account,
  kind,
  done,
}: {
  account: Account;
  kind: "task" | "product";
  done: (id: string) => void;
}) {
  const [draft, setDraft] = useState(initial),
    [ready, setReady] = useState(false),
    [step, setStep] = useState(1),
    [formError, setFormError] = useState<Error | null>(null),
    [draftNotice, setDraftNotice] = useState("");
  const capabilities = useResource<{ transactionTerms: boolean }>(
    "capabilities",
  );
  const mutation = useMutation(account.id),
    storage = `campus:draft:${account.id}:${kind}`;
  const formRef = useRef<HTMLFormElement>(null),
    dirty = useRef(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storage) || "null");
      if (
        saved &&
        [
          "title",
          "description",
          "category",
          "amount",
          "stock",
          "shippingAmount",
        ].every((k) => typeof saved[k] === "string") &&
        typeof saved.pickup === "boolean" &&
        typeof saved.shipping === "boolean" &&
        Array.isArray(saved.milestones) &&
        saved.milestones.length >= 1 &&
        saved.milestones.length <= 20 &&
        saved.milestones.every(
          (m: Record<string, unknown>) =>
            m &&
            ["title", "amount", "deliverable"].every(
              (k) => typeof m[k] === "string",
            ),
        )
      ) {
        setDraft({
          ...initial,
          ...saved,
          dueDate: typeof saved.dueDate === "string" ? saved.dueDate : "",
          milestones: saved.milestones.map((m: Record<string, string>) => ({
            title: m.title,
            amount: m.amount,
            deliverable: m.deliverable,
            acceptanceCriteria:
              typeof m.acceptanceCriteria === "string"
                ? m.acceptanceCriteria
                : "",
          })),
        });
        setDraftNotice("Your saved draft has been restored.");
      }
    } catch {
      /* A corrupt or unavailable draft does not block publishing. */
    }
    setReady(true);
  }, [storage]);
  useEffect(() => {
    if (!ready || !dirty.current) return;
    try {
      localStorage.setItem(storage, JSON.stringify(draft));
      setDraftNotice(
        "Draft saved automatically on this device for your account.",
      );
    } catch {
      setDraftNotice(
        "Draft storage is unavailable. Keep this page open to preserve your entries.",
      );
    }
  }, [draft, ready, storage]);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [step]);
  function update(patch: Partial<typeof initial>) {
    dirty.current = true;
    setDraft((old) => ({ ...old, ...patch }));
    setFormError(null);
  }
  function payload() {
    const amount = dollarsToCents(draft.amount);
    if (!draft.title.trim() || !draft.description.trim())
      throw new Error("Add a title and description.");
    if (kind === "product") {
      if (!draft.pickup && !draft.shipping)
        throw new Error("Choose at least one delivery method.");
      return {
        title: draft.title,
        description: draft.description,
        priceCents: amount,
        stock: Number(draft.stock),
        deliveryMethods: [
          ...(draft.pickup ? ["pickup"] : []),
          ...(draft.shipping ? ["shipping"] : []),
        ],
        shippingCents: draft.shipping
          ? dollarsToCents(draft.shippingAmount, { zero: true, max: 10000000 })
          : 0,
      };
    }
    if (capabilities.loading || capabilities.error)
      throw Error(
        "Wait for current transaction capabilities before publishing.",
      );
    if (capabilities.data?.transactionTerms && !draft.releasePolicy)
      throw Error("Choose a release policy explicitly.");
    validateTaskTerms(draft.dueDate, draft.milestones);
    const milestones = draft.milestones.map((m) => ({
      title: m.title,
      deliverable: m.deliverable,
      amountCents: dollarsToCents(m.amount),
      acceptanceCriteria: m.acceptanceCriteria.trim(),
    }));
    if (milestones.some((m) => !m.title.trim() || !m.deliverable.trim()))
      throw new Error(
        "Describe the title and deliverable for every milestone.",
      );
    if (milestones.reduce((s, m) => s + m.amountCents, 0) !== amount)
      throw new Error(
        "Milestone amounts must add up to the total bounty reward.",
      );
    return {
      title: draft.title,
      description: draft.description,
      category: draft.category,
      rewardCents: amount,
      ...(capabilities.data?.transactionTerms
        ? { releasePolicy: draft.releasePolicy }
        : {}),
      dueDate: draft.dueDate,
      milestones,
    };
  }
  if (!ready) return <p role="status">Opening your draft…</p>;
  return (
    <section className="cb-compose">
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Make something happen</span>
          <h1>{kind === "task" ? "Post a bounty" : "List an item"}</h1>
        </div>
        <button
          className="cb-button"
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(storage, JSON.stringify(draft));
              setDraftNotice("Draft saved on this device for your account.");
            } catch {
              setFormError(
                new Error(
                  "Your browser could not save the draft. Keep this page open to preserve your entries.",
                ),
              );
            }
          }}
        >
          Save draft
        </button>
      </div>
      <p role="status" className="cb-muted">
        {draftNotice || "Only published listings are visible to members."}
      </p>
      <ol className="cb-steps" aria-label="Publishing progress">
        {["Details", kind === "task" ? "Milestones" : "Delivery", "Review"].map(
          (s, i) => (
            <li key={s} aria-current={step === i + 1 ? "step" : undefined}>
              <b>{i + 1}</b> {s}
            </li>
          ),
        )}
      </ol>
      <Feedback error={formError || mutation.error} notice={mutation.notice} />
      <form
        ref={formRef}
        className="cb-panel"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (step === 1) {
              dollarsToCents(draft.amount);
              if (kind === "task" && !isCalendarDate(draft.dueDate))
                throw new Error("Choose a valid target delivery date.");
              setStep(2);
            } else if (step === 2) {
              payload();
              setStep(3);
            } else {
              const r = await mutation.run<{ id: string }>(
                kind === "task" ? "tasks" : "products",
                payload(),
                "Published.",
              );
              if (r) {
                try {
                  localStorage.removeItem(storage);
                } catch {
                  /* optional */
                }
                done(r.id);
              }
            }
          } catch (error) {
            setFormError(error as Error);
          }
        }}
      >
        {step === 1 && (
          <>
            <h2 tabIndex={-1}>What are you posting?</h2>
            <Field label="Title">
              <input
                required
                maxLength={160}
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder={
                  kind === "task"
                    ? "Analyze survey data for a campus research project"
                    : "Introduction to Algorithms — fourth edition"
                }
              />
            </Field>
            <Field
              label="Description"
              help="Explain the scope, condition, or requirements someone should know before committing."
            >
              <textarea
                required
                maxLength={10000}
                rows={6}
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
                pattern="[0-9]+(\.[0-9]{1,2})?"
                value={draft.amount}
                onChange={(e) => update({ amount: e.target.value })}
                placeholder="350.00"
              />
            </Field>
            {kind === "product" && (
              <Field label="Available quantity">
                <input
                  required
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={draft.stock}
                  onChange={(e) => update({ stock: e.target.value })}
                />
              </Field>
            )}
            {kind === "task" && (
              <Field
                label="Target delivery date"
                help="Choose the calendar date you want the final work delivered. This is a delivery target, not an application closing date."
              >
                <input
                  required
                  type="date"
                  min="1000-01-01"
                  max="9999-12-31"
                  value={draft.dueDate}
                  onChange={(e) => update({ dueDate: e.target.value })}
                />
              </Field>
            )}
          </>
        )}
        {step === 2 && kind === "task" && (
          <>
            <h2 tabIndex={-1}>Set clear milestones</h2>
            {capabilities.data?.transactionTerms && (
              <ReleaseChoice
                value={draft.releasePolicy}
                onChange={(releasePolicy) => update({ releasePolicy })}
              />
            )}
            <p>
              Split {money(dollarsToCents(draft.amount))} into deliverables you
              can review. Individual students and teams can apply.
            </p>
            {draft.milestones.map((m, i) => (
              <fieldset key={i}>
                <legend>Milestone {i + 1}</legend>
                {(
                  [
                    "title",
                    "deliverable",
                    "acceptanceCriteria",
                    "amount",
                  ] as const
                ).map((key) => (
                  <Field
                    key={key}
                    label={
                      key === "amount"
                        ? "Milestone reward (USD)"
                        : key === "title"
                          ? "Milestone title"
                          : key === "acceptanceCriteria"
                            ? "Acceptance criteria"
                            : "Expected deliverable"
                    }
                    help={
                      key === "acceptanceCriteria"
                        ? "Say how you will judge the work. For example: all survey rows are included, missing values are explained, and the analysis can be reproduced. One requirement per line works well."
                        : undefined
                    }
                  >
                    {key === "deliverable" || key === "acceptanceCriteria" ? (
                      <textarea
                        required
                        maxLength={10000}
                        rows={key === "acceptanceCriteria" ? 4 : 3}
                        value={m[key]}
                        onChange={(e) =>
                          update({
                            milestones: draft.milestones.map((v, n) =>
                              n === i ? { ...v, [key]: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    ) : (
                      <input
                        required
                        maxLength={key === "title" ? 160 : 10}
                        inputMode={key === "amount" ? "decimal" : "text"}
                        value={m[key]}
                        onChange={(e) =>
                          update({
                            milestones: draft.milestones.map((v, n) =>
                              n === i ? { ...v, [key]: e.target.value } : v,
                            ),
                          })
                        }
                      />
                    )}
                  </Field>
                ))}
                {draft.milestones.length > 1 && (
                  <button
                    className="cb-text-button"
                    type="button"
                    onClick={() =>
                      update({
                        milestones: draft.milestones.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove milestone {i + 1}
                  </button>
                )}
              </fieldset>
            ))}
            <button
              className="cb-button"
              type="button"
              disabled={draft.milestones.length >= 20}
              onClick={() =>
                update({
                  milestones: [
                    ...draft.milestones,
                    {
                      title: "",
                      amount: "",
                      deliverable: "",
                      acceptanceCriteria: "",
                    },
                  ],
                })
              }
            >
              Add milestone
            </button>
          </>
        )}
        {step === 2 && kind === "product" && (
          <>
            <h2 tabIndex={-1}>How will you hand it over?</h2>
            <p>Offer campus pickup, shipping within the U.S., or both.</p>
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
                  onChange={(e) => update({ shippingAmount: e.target.value })}
                />
              </Field>
            )}
            <p className="cb-fine">
              The buyer’s address is visible only to the buyer and seller.
              Shipping labels are not provided.
            </p>
          </>
        )}
        {step === 3 && (
          <>
            <h2 tabIndex={-1}>Review before publishing</h2>
            <h3>{draft.title}</h3>
            <p className="cb-prewrap">{draft.description}</p>
            <p className="cb-price">{money(dollarsToCents(draft.amount))}</p>
            {kind === "task" ? (
              <>
                <ReleaseDisclosure policy={draft.releasePolicy} />
                <div className="cb-terms-summary">
                  <strong>Target delivery date</strong>
                  <time dateTime={draft.dueDate}>
                    {formatDueDate(draft.dueDate)}
                  </time>
                  <p className="cb-fine">
                    This calendar date will be included in the agreement. It
                    does not automatically close applications or cancel work.
                  </p>
                </div>
                <ol>
                  {draft.milestones.map((m, i) => (
                    <li key={i}>
                      <strong>
                        {m.title} · {money(dollarsToCents(m.amount))}
                      </strong>
                      <p className="cb-prewrap">
                        <strong>Deliverable</strong>
                        <br />
                        {m.deliverable}
                      </p>
                      <p className="cb-prewrap">
                        <strong>Acceptance criteria</strong>
                        <br />
                        {m.acceptanceCriteria}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p>
                {draft.stock} available ·{" "}
                {[
                  draft.pickup && "Campus pickup",
                  draft.shipping &&
                    `Shipping ${money(dollarsToCents(draft.shippingAmount, { zero: true }))}`,
                ]
                  .filter(Boolean)
                  .join(" / ")}
              </p>
            )}
            <p className="cb-alert">
              Payments are not enabled in this preview. Publishing does not
              collect or transfer money.
            </p>
            <p>
              You can edit or pause this listing after publishing. Signed
              agreements and existing orders keep their original terms. Changes
              require participants to review the new version.
            </p>
          </>
        )}
        <div className="cb-actions">
          {step > 1 && (
            <button
              className="cb-button"
              type="button"
              disabled={mutation.busy}
              onClick={() => {
                setStep((s) => s - 1);
                setFormError(null);
              }}
            >
              Back
            </button>
          )}
          <PendingButton busy={mutation.busy}>
            {step === 3 ? "Publish listing" : "Continue"}
          </PendingButton>
        </div>
      </form>
    </section>
  );
}
