import { runtime as getRuntime } from "@/lib/backend.mjs";
import { paymentWebhook } from "../../../../../../backend/http/payment-webhook.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = paymentWebhook(getRuntime, { thin: true });
