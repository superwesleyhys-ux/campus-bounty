import { createRuntime } from "../backend/runtime.mjs";
import { createPaymentWorker } from "../backend/adapters/payment-worker.mjs";
const runtime = await createRuntime();
if (!runtime.paymentAdapter) {
  await runtime.store.close();
  throw Error("Payments are not configured");
}
const worker = createPaymentWorker(runtime.store, runtime.paymentAdapter);
let stop = false;
process.once("SIGTERM", () => {
  stop = true;
});
process.once("SIGINT", () => {
  stop = true;
});
try {
  do {
    try {
      const result = await worker.tick();
      console.log(JSON.stringify({ event: "payment_worker_tick", ...result }));
    } catch {
      console.error(JSON.stringify({ event: "payment_worker_unavailable" }));
    }
    if (process.argv.includes("--once")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (!stop);
} finally {
  await runtime.store.close();
}
