import {
  z,
  parse,
  found,
  requireThat,
  uuid,
  title,
  text,
  money,
  context,
  catalogQuery,
  searchPattern,
} from "../../../backend/modules/common.mjs";
export const productSchema = z.strictObject({
  title,
  description: text,
  priceCents: money,
  stock: z.number().int().min(0).max(100000),
  deliveryMethods: z
    .array(z.enum(["pickup", "shipping"]))
    .min(1)
    .max(2)
    .refine((v) => new Set(v).size === v.length),
  shippingCents: z.number().int().min(0).max(10000000).default(0),
});
const addressSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
  country: z.literal("US"),
});
export function goodsModule(store) {
  const { read, privateRead, command } = context(store);
  return {
    products: async (actor, input) => {
      const p = catalogQuery(input);
      return read(actor, async (c) => {
        const where =
          "WHERE (title ILIKE $1 OR description ILIKE $1) AND ($2::uuid IS NULL OR seller_id=$2)";
        const args = [searchPattern(p.q), p.scope === "mine" ? actor : null];
        const sort = {
          recent: "created_at DESC",
          amount_asc: "price_cents ASC",
          amount_desc: "price_cents DESC",
        }[p.sort];
        return {
          items: (
            await c.query(
              `SELECT id,seller_id,title,description,price_cents,stock,delivery_methods,shipping_cents,revision,created_at FROM campus.products ${where} ORDER BY ${sort},id DESC LIMIT $3 OFFSET $4`,
              [...args, p.limit, p.offset],
            )
          ).rows,
          total: (
            await c.query(
              `SELECT count(*)::int AS total FROM campus.products ${where}`,
              args,
            )
          ).rows[0].total,
          limit: p.limit,
          offset: p.offset,
        };
      });
    },
    product: async (actor, id) => {
      uuid(id);
      return read(actor, async (c) =>
        found(
          (await c.query("SELECT * FROM campus.products WHERE id=$1", [id]))
            .rows[0],
        ),
      );
    },
    publishProduct: async (actor, input, key) => {
      const d = parse(productSchema, input);
      return command(
        actor,
        "product.publish",
        key,
        d,
        async (c) =>
          (
            await c.query(
              "INSERT INTO campus.products(seller_id,title,description,price_cents,stock,delivery_methods,shipping_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
              [
                actor,
                d.title,
                d.description,
                d.priceCents,
                d.stock,
                d.deliveryMethods,
                d.shippingCents,
              ],
            )
          ).rows[0],
      );
    },
    quote: async (actor, id, input, key) => {
      uuid(id);
      const d = parse(
        z.strictObject({
          quantity: z.number().int().min(1).max(100),
          deliveryMethod: z.enum(["pickup", "shipping"]),
        }),
        input,
      );
      return command(actor, "product.quote:" + id, key, d, async (c) => {
        const p = found(
          (await c.query("SELECT * FROM campus.products WHERE id=$1", [id]))
            .rows[0],
        );
        requireThat(
          p.seller_id !== actor,
          409,
          "self_purchase",
          "You cannot purchase your own listing.",
        );
        requireThat(
          p.delivery_methods.includes(d.deliveryMethod),
          422,
          "delivery_unavailable",
          "This delivery method is unavailable.",
        );
        requireThat(
          p.stock >= d.quantity,
          409,
          "out_of_stock",
          "Not enough inventory is available.",
        );
        requireThat(
          p.price_cents * d.quantity +
            (d.deliveryMethod === "shipping" ? p.shipping_cents : 0) <=
            100000000,
          422,
          "order_limit",
          "The order amount exceeds the supported limit.",
        );
        return (
          await c.query(
            "INSERT INTO campus.quotes(product_id,buyer_id,seller_id,product_revision,quantity,unit_cents,shipping_cents,delivery_method,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes') RETURNING *",
            [
              id,
              actor,
              p.seller_id,
              p.revision,
              d.quantity,
              p.price_cents,
              d.deliveryMethod === "shipping" ? p.shipping_cents : 0,
              d.deliveryMethod,
            ],
          )
        ).rows[0];
      });
    },
    order: async (actor, input, key) => {
      const d = parse(
        z.strictObject({
          quoteId: z.uuid(),
          shippingAddress: addressSchema.optional(),
        }),
        input,
      );
      return command(actor, "order.create", key, d, (c) =>
        orderCommand(c, "SELECT * FROM campus.create_order_from_quote($1,$2)", [
          d.quoteId,
          d.shippingAddress ? JSON.stringify(d.shippingAddress) : null,
        ]),
      );
    },
    cancelOrder: async (actor, id, input, key) => {
      uuid(id);
      const d = parse(z.strictObject({}), input);
      return command(actor, "order.cancel:" + id, key, d, (c) =>
        orderCommand(c, "SELECT * FROM campus.cancel_unpaid_order($1)", [id]),
      );
    },
    orders: (actor) =>
      privateRead(
        actor,
        async (c) =>
          (
            await c.query(
              "SELECT id,product_id,buyer_id,seller_id,total_cents,delivery_method,state,reserved_until,terms,created_at FROM campus.orders ORDER BY created_at DESC,id DESC LIMIT 100",
            )
          ).rows,
      ),
    getOrder: async (actor, id) => {
      uuid(id);
      return privateRead(actor, async (c) =>
        found(
          (await c.query("SELECT * FROM campus.orders WHERE id=$1", [id]))
            .rows[0],
        ),
      );
    },
    fulfillOrder: async (actor, id, input, key) => {
      uuid(id);
      const d = parse(
        z.strictObject({
          carrier: z.string().trim().min(1).max(100).optional(),
          trackingNumber: z.string().trim().min(1).max(100).optional(),
        }),
        input,
      );
      return command(actor, "order.fulfill:" + id, key, d, async (c) => {
        const order = found(
          (
            await c.query(
              "SELECT * FROM campus.orders WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0],
        );
        requireThat(
          order.seller_id === actor,
          403,
          "not_seller",
          "Only the seller can fulfill the order.",
        );
        requireThat(
          order.state === "paid",
          409,
          "payment_required",
          "Confirmed payment is required before fulfillment.",
        );
        requireThat(
          order.delivery_method !== "shipping" ||
            (d.carrier && d.trackingNumber),
          422,
          "tracking_required",
          "Provide a carrier and tracking number.",
        );
        requireThat(
          order.delivery_method !== "pickup" ||
            (!d.carrier && !d.trackingNumber),
          422,
          "unexpected_tracking",
          "Pickup does not require tracking.",
        );
        return (
          await c.query(
            "UPDATE campus.orders SET state=$2,carrier=$3,tracking_number=$4 WHERE id=$1 RETURNING *",
            [
              id,
              order.delivery_method === "shipping"
                ? "shipped"
                : "ready_for_pickup",
              d.carrier || null,
              d.trackingNumber || null,
            ],
          )
        ).rows[0];
      });
    },
    completeOrder: async (actor, id, input, key) => {
      uuid(id);
      parse(z.strictObject({}), input);
      return command(actor, "order.complete:" + id, key, {}, async (c) => {
        const order = found(
          (
            await c.query(
              "SELECT * FROM campus.orders WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0],
        );
        requireThat(
          order.buyer_id === actor,
          403,
          "not_buyer",
          "Only the buyer can confirm receipt.",
        );
        requireThat(
          ["shipped", "ready_for_pickup"].includes(order.state),
          409,
          "invalid_state",
          "This order is not ready to complete.",
        );
        return (
          await c.query(
            "UPDATE campus.orders SET state='completed' WHERE id=$1 RETURNING *",
            [id],
          )
        ).rows[0];
      });
    },
    expireReservations: async () =>
      Number(
        (
          await store.worker.query(
            "SELECT campus.expire_reservations() AS count",
          )
        ).rows[0].count,
      ),
  };
}

const orderProblems = {
  membership_required: [
    403,
    "A current verified campus membership is required.",
  ],
  account_restricted: [403, "This account cannot start new activity."],
  not_found: [404, "Resource not found."],
  invalid_input: [422, "Request fields are invalid."],
  not_buyer: [403, "Only the buyer can cancel the order."],
  invalid_state: [409, "Only an unpaid order can be cancelled."],
  quote_consumed: [409, "This quote already has an order."],
  quote_expired: [409, "Request a new quote."],
  shipping_address_required: [422, "A shipping address is required."],
  unexpected_address: [422, "A pickup order does not need a shipping address."],
  self_purchase: [409, "You cannot purchase your own listing."],
  stale_quote: [409, "This listing changed. Request a new quote."],
  order_limit: [422, "The order amount exceeds the supported limit."],
  out_of_stock: [409, "Not enough inventory is available."],
};
async function orderCommand(c, sql, values) {
  try {
    return (await c.query(sql, values)).rows[0];
  } catch (error) {
    const problem = error.code === "P0001" && orderProblems[error.message];
    if (problem) requireThat(false, problem[0], error.message, problem[1]);
    throw error;
  }
}
