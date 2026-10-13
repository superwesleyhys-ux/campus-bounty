import nodemailer from "nodemailer";
import { createRuntime } from "../backend/runtime.mjs";
import { createMailWorker } from "../backend/adapters/mail-worker.mjs";
const runtime = await createRuntime(),
  transport = nodemailer.createTransport(runtime.config.smtp);
const worker = createMailWorker(runtime.store, {
  encryptionKey: runtime.config.encryptionKey,
  from: runtime.config.from,
  transport,
});
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
while (!stopping) {
  try {
    await worker.tick();
    await runtime.market.expireReservations();
  } catch {
    console.error("Campus worker tick failed.");
  }
  await new Promise((r) => setTimeout(r, 1000));
}
transport.close();
await runtime.store.close();
