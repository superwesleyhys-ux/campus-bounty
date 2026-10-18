"use client";
import { ListingManagement } from "./listing-management";
import { useEffect, useState } from "react";
import { ApiError, useMutation, useResource } from "./api";
import { money, type Account, type Product, type Quote } from "./types";
import { Feedback, Field, PendingButton, ResourceState } from "./ui";

export function ProductDetail({
  id,
  account,
  openOrder,
}: {
  id: string;
  account: Account;
  openOrder: (id: string) => void;
}) {
  const resource = useResource<Product>(`products/${id}`),
    mutation = useMutation(account.id),
    p = resource.data;
  const [quote, setQuote] = useState<Quote | null>(null),
    [now, setNow] = useState(0),
    [quantity, setQuantity] = useState(1),
    [delivery, setDelivery] = useState("");
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!p) return <ResourceState {...resource} />;
  const method = p.delivery_methods.includes(delivery)
      ? delivery
      : p.delivery_methods[0],
    expired = !!quote && new Date(quote.expires_at).getTime() <= now;
  const unknown =
    mutation.error instanceof ApiError &&
    (mutation.error.status === 0 || mutation.error.status >= 500);
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">Campus marketplace</span>
          <h1>{p.title}</h1>
        </div>
        <div className="cb-reward">
          <small>Per item</small>
          <strong>{money(p.price_cents)}</strong>
        </div>
      </div>
      <ListingManagement
        listing={p}
        kind="product"
        account={account}
        reload={resource.reload}
      />
      <div className="cb-detail-grid">
        <section className="cb-panel">
          <h2>About this item</h2>
          <p className="cb-prewrap">{p.description}</p>
          <h3>Available delivery</h3>
          <ul>
            {p.delivery_methods.map((d) => (
              <li key={d}>
                {d === "pickup"
                  ? "Campus pickup — coordinate with the seller"
                  : `U.S. shipping — ${money(p.shipping_cents)} per order`}
              </li>
            ))}
          </ul>
          <p>{p.stock} available</p>
        </section>
        <aside className="cb-panel">
          <h2>{quote ? "Review your reservation" : "Choose your options"}</h2>
          <Feedback {...mutation} />
          {mutation.error instanceof ApiError &&
            ["stale_revision", "stale_quote", "listing_unavailable"].includes(
              mutation.error.code,
            ) && (
              <button
                className="cb-button"
                onClick={() => {
                  setQuote(null);
                  setDelivery("");
                  mutation.clear();
                  resource.reload();
                }}
              >
                Review latest listing and request a new quote
              </button>
            )}
          {p.seller_id === account.id ? (
            <p>
              This is your listing. Purchases from your own account are
              disabled.
            </p>
          ) : p.visibility === "paused" && !unknown ? (
            <p>
              This listing is paused. New purchases are unavailable. Your
              existing orders remain in Workspace.
            </p>
          ) : !quote ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await mutation.run<Quote>(
                  `products/${id}/quotes`,
                  {
                    quantity,
                    deliveryMethod: method,
                    expectedRevision: p.revision,
                    expectedTermsVersion: p.terms_version,
                  },
                  "",
                );
                if (result) setQuote(result);
              }}
            >
              <Field label="Quantity">
                <input
                  type="number"
                  required
                  min={1}
                  max={Math.min(100, p.stock)}
                  step={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                />
              </Field>
              <Field label="Delivery method">
                <select
                  value={method}
                  onChange={(e) => setDelivery(e.target.value)}
                >
                  {p.delivery_methods.map((d) => (
                    <option value={d} key={d}>
                      {d === "pickup" ? "Campus pickup" : "U.S. shipping"}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="cb-fine">
                Review the exact total before reserving. A quote does not
                reserve inventory.
              </p>
              <PendingButton busy={mutation.busy} disabled={p.stock < 1}>
                Review total
              </PendingButton>
            </form>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const values = Object.fromEntries(
                  new FormData(e.currentTarget),
                );
                const result = await mutation.run<{ id: string }>(
                  "orders",
                  {
                    quoteId: quote.id,
                    ...(quote.delivery_method === "shipping"
                      ? { shippingAddress: { ...values, country: "US" } }
                      : {}),
                  },
                  "Reservation created.",
                );
                if (result) openOrder(result.id);
              }}
            >
              <dl className="cb-totals">
                <div>
                  <dt>
                    {quote.quantity} × {money(quote.unit_cents)}
                  </dt>
                  <dd>{money(quote.quantity * quote.unit_cents)}</dd>
                </div>
                <div>
                  <dt>
                    {quote.delivery_method === "pickup"
                      ? "Campus pickup"
                      : "Shipping"}
                  </dt>
                  <dd>{money(quote.shipping_cents)}</dd>
                </div>
                <div>
                  <dt>Total (USD)</dt>
                  <dd>
                    <strong>
                      {money(
                        quote.quantity * quote.unit_cents +
                          quote.shipping_cents,
                      )}
                    </strong>
                  </dd>
                </div>
              </dl>
              <p>
                {expired
                  ? "This quote has expired."
                  : `Quote valid until ${new Date(quote.expires_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`}
              </p>
              {quote.delivery_method === "shipping" && (
                <fieldset>
                  <legend>Shipping address · United States</legend>
                  {[
                    ["name", "Recipient name", "name", 100],
                    ["line1", "Street address", "address-line1", 200],
                    [
                      "line2",
                      "Apartment, suite (optional)",
                      "address-line2",
                      200,
                    ],
                    ["city", "City", "address-level2", 100],
                    ["region", "State", "address-level1", 100],
                    ["postalCode", "ZIP code", "postal-code", 20],
                  ].map(([name, title, auto, max]) => (
                    <Field key={name} label={String(title)}>
                      <input
                        name={String(name)}
                        required={name !== "line2"}
                        autoComplete={String(auto)}
                        maxLength={Number(max)}
                      />
                    </Field>
                  ))}
                  <p className="cb-fine">
                    Only you and the seller can view this address. It is not
                    saved as a browser draft.
                  </p>
                </fieldset>
              )}
              <p className="cb-alert">
                This creates an unpaid reservation for 15 minutes. No money is
                collected and the seller cannot ship or hand over the item yet.
              </p>
              {unknown && (
                <p role="status">
                  The last result is uncertain. Retry with the same details to
                  recover the reservation before starting another.
                </p>
              )}
              <PendingButton
                busy={mutation.busy}
                disabled={expired && !unknown}
              >
                {unknown
                  ? "Check reservation / retry"
                  : "Create unpaid reservation"}
              </PendingButton>
              <button
                className="cb-text-button"
                type="button"
                disabled={mutation.busy || unknown}
                onClick={() => {
                  setQuote(null);
                  mutation.clear();
                  resource.reload();
                }}
              >
                {expired ? "Get a new quote" : "Change options"}
              </button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
