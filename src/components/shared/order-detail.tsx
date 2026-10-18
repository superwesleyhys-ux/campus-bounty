"use client";
import { ParticipantPayment } from "./participant-payment";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { historyDetailUrl } from "./history-pagination";
import { useEffect, useRef } from "react";
import { ApiError, useMutation, useResource } from "./api";
import { ListingEventVersion } from "./listing-event-version";
import { ConfirmAction } from "./confirm-action";
import { Conversation } from "./conversation";
import { money, type Account, type Order } from "./types";
import { Feedback, Field, PendingButton, ResourceState, Status } from "./ui";

export function OrderDetail({ id, account }: { id: string; account: Account }) {
  const query = useSearchParams();
  const heading = useRef<HTMLHeadingElement>(null);
  const resource = useResource<Order>(`orders/${id}`),
    mutation = useMutation(account.id),
    order = resource.data;
  const uncertain =
    !!mutation.error &&
    (!(mutation.error instanceof ApiError) ||
      mutation.error.status === 0 ||
      mutation.error.status >= 500);
  const clear = mutation.clear;
  useEffect(() => {
    if (order && ["cancelled", "expired"].includes(order.state)) clear();
  }, [order?.state, clear]);
  if (!order) return <ResourceState {...resource} />;
  const seller = order.seller_id === account.id;
  return (
    <>
      <div className="cb-heading">
        <div>
          <span className="cb-eyebrow">{seller ? "Sale" : "Your order"}</span>
          <h1 ref={heading} tabIndex={-1}>
            {order.terms.title}
          </h1>
          <Status value={order.state} />
        </div>
        <strong className="cb-price">{money(order.total_cents)}</strong>
      </div>
      <ListingEventVersion kind="product" id={order.product_id} />
      <ParticipantPayment key={`${account.id}:${id}`} account={account.id} id={id} kind="order" onChanged={resource.reload} />
      <div className="cb-detail-grid cb-conversation-detail">
        <section>
          <div className="cb-panel">
            <h2>Order details</h2>
            <dl className="cb-totals">
              <div>
                <dt>Items</dt>
                <dd>
                  {order.quantity} × {money(order.terms.unitCents)}
                </dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>
                  {order.delivery_method === "pickup"
                    ? "Campus pickup"
                    : "U.S. shipping"}
                </dd>
              </div>
              <div>
                <dt>Shipping</dt>
                <dd>{money(order.terms.shippingCents)}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{money(order.total_cents)}</dd>
              </div>
            </dl>
            {order.state === "pending_payment" && (
              <div className="cb-alert">
                <strong>Unpaid reservation</strong>
                <p>
                  Reserved until{" "}
                  {new Date(order.reserved_until).toLocaleString("en-US")}.
                  Payment status is shown above. Cancellation or expiry may retain
                  inventory while a payment outcome is unknown.
                </p>
                <button className="cb-button" onClick={resource.reload}>
                  Refresh order status
                </button>
                {!seller && (
                  <ConfirmAction
                    headingLevel={3}
                    cancelLabel="Keep reservation"
                    label="Cancel reservation"
                    description="Request cancellation. Payment attempts must be resolved before inventory can return; already received or late money may remain held for review."
                    confirmLabel="Confirm cancellation"
                    busy={mutation.busy}
                    uncertain={uncertain}
                    disabled={resource.loading}
                    onCheckStatus={() => {
                      heading.current?.focus();
                      resource.reload();
                    }}
                    onConfirm={async () => {
                      const result = await mutation.run<Order>(
                        `orders/${id}/cancellation`,
                        {},
                        "Cancellation requested. Read the current payment and reservation status.",
                      );
                      if (result) {
                        heading.current?.focus();
                        resource.reload();
                      }
                      return !!result;
                    }}
                  />
                )}
              </div>
            )}
            {order.state === "expired" && (
              <p className="cb-alert">
                This reservation expired. Check current funding and listing availability; late received money may remain held.
              </p>
            )}
            {order.state === "cancelled" && (
              <p className="cb-alert">
                This reservation was cancelled. Check current payment status for
                any received, late or held funds.
              </p>
            )}
            {["cancelled", "expired"].includes(order.state) && (
              <Link
                className="cb-text-button"
                href={historyDetailUrl(query, "market", order.product_id)}
              >
                View listing and availability →
              </Link>
            )}
            {order.shipping_address && (
              <section>
                <h3>Shipping address</h3>
                <address>
                  {[
                    "name",
                    "line1",
                    "line2",
                    "city",
                    "region",
                    "postalCode",
                    "country",
                  ]
                    .filter((k) => order.shipping_address?.[k])
                    .map((k) => (
                      <span key={k}>
                        {order.shipping_address?.[k]}
                        <br />
                      </span>
                    ))}
                </address>
              </section>
            )}
            {order.tracking_number && (
              <p>
                Tracking: {order.carrier} ·{" "}
                <strong>{order.tracking_number}</strong>
              </p>
            )}
            <Feedback {...mutation} />
            {seller && order.state === "paid" && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const body = Object.fromEntries(
                    new FormData(e.currentTarget),
                  );
                  const r = await mutation.run(
                    `orders/${id}/fulfillment`,
                    body,
                    "Fulfillment recorded.",
                  );
                  if (r) resource.reload();
                }}
              >
                {order.delivery_method === "shipping" && (
                  <>
                    <Field label="Carrier">
                      <input name="carrier" required maxLength={100} />
                    </Field>
                    <Field label="Tracking number">
                      <input name="trackingNumber" required maxLength={100} />
                    </Field>
                  </>
                )}
                <PendingButton busy={mutation.busy}>
                  {order.delivery_method === "shipping"
                    ? "Record shipment"
                    : "Mark ready for pickup"}
                </PendingButton>
              </form>
            )}
            {!seller &&
              ["shipped", "ready_for_pickup"].includes(order.state) && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const r = await mutation.run(
                      `orders/${id}/receipt`,
                      {},
                      "Receipt confirmed. Your order is complete.",
                    );
                    if (r) resource.reload();
                  }}
                >
                  <label className="cb-check">
                    <input type="checkbox" required />I have received this item.
                  </label>
                  <PendingButton busy={mutation.busy}>
                    Confirm receipt
                  </PendingButton>
                </form>
              )}
          </div>
        </section>
        <aside>
          <Conversation scope="orderId" id={id} account={account} />
        </aside>
      </div>
    </>
  );
}
