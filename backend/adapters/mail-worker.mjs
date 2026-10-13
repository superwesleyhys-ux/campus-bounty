import { randomUUID } from "node:crypto";
import { unseal, secretKey } from "../crypto.mjs";
import { senderAddress } from "./mail-config.mjs";
export function createMailWorker(store, { encryptionKey, transport, from }) {
  secretKey(encryptionKey);
  const senderDomain = senderAddress(from).split("@")[1];
  return {
    async tick() {
      const lease = randomUUID();
      const job = await store.workerTx(async (c) => {
        await c.query(
          "UPDATE campus.mail_jobs SET status='dead',payload=NULL,last_error='expired',lease_id=NULL,lease_until=NULL WHERE expires_at<=now() AND status IN ('pending','sending')",
        );
        await c.query(
          "UPDATE campus.mail_jobs SET status='dead',payload=NULL,last_error='retry_exhausted',lease_id=NULL,lease_until=NULL WHERE attempts>=5 AND (status='pending' OR (status='sending' AND lease_until<now()))",
        );
        const row = (
          await c.query(
            "SELECT id FROM campus.mail_jobs WHERE expires_at>now() AND available_at<=now() AND (status='pending' OR (status='sending' AND lease_until<now())) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1",
          )
        ).rows[0];
        if (!row) return null;
        return (
          await c.query(
            "UPDATE campus.mail_jobs SET status='sending',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '2 minutes' WHERE id=$1 RETURNING *",
            [row.id, lease],
          )
        ).rows[0];
      });
      if (!job) return false;
      try {
        const data = unseal(encryptionKey, job.payload);
        const receipt = await transport.sendMail({
          from,
          to: data.to,
          subject: "Your Campus Bounty verification code",
          text: `Your verification code is ${data.code}. It expires at ${new Date(job.expires_at).toISOString()} (UTC). If you did not request this, ignore this email.`,
          messageId: `<${job.id}@${senderDomain}>`,
        });
        // Provider acceptance is not inbox delivery. Never treat an undefined,
        // rejected, or unrelated-recipient response as acceptance of this code.
        if (
          !Array.isArray(receipt?.accepted) ||
          !receipt.accepted.some(
            (address) =>
              typeof address === "string" &&
              address.toLowerCase() === data.to.toLowerCase(),
          ) ||
          (receipt.rejected?.length || 0) > 0
        )
          throw Error("Mail recipient was not accepted");
        await store.worker.query(
          "UPDATE campus.mail_jobs SET status='sent',payload=NULL,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_id=$2 AND status='sending'",
          [job.id, lease],
        );
      } catch {
        await store.worker.query(
          "UPDATE campus.mail_jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'pending' END,payload=CASE WHEN attempts>=5 THEN NULL ELSE payload END,available_at=now()+make_interval(secs=>least(600,10*power(2,attempts)::integer)),lease_id=NULL,lease_until=NULL,last_error='delivery_failed' WHERE id=$1 AND lease_id=$2 AND status='sending'",
          [job.id, lease],
        );
      }
      return true;
    },
  };
}
