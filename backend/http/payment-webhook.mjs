import { createHash } from "node:crypto";
export function paymentWebhook(getRuntime, { thin = false } = {}) {
  return async (request) => {
    let runtime, parsed, bytes;
    try {
      runtime = await getRuntime();
    } catch {
      return new Response(null, { status: 503 });
    }
    if (!runtime.paymentAdapter) return new Response(null, { status: 503 });
    try {
      const reader = request.body?.getReader(),
        chunks = [];
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 262144) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      bytes = Buffer.concat(chunks);
      parsed = runtime.paymentAdapter.parseWebhook(
        bytes,
        request.headers.get("stripe-signature"),
        thin,
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      await runtime.store.workerTx((c) =>
        c.query("SELECT campus.money_inbox_insert($1,$2,$3,$4,$5,$6,$7)", [
          runtime.paymentAdapter.environment.id,
          parsed.origin,
          parsed.event.id,
          parsed.event.type,
          createHash("sha256").update(bytes).digest("hex"),
          JSON.stringify(parsed.body),
          thin ? "thin" : "snapshot",
        ]),
      );
      return Response.json(
        { received: true },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return new Response(null, { status: e.code === "P0001" ? 400 : 503 });
    }
  };
}
