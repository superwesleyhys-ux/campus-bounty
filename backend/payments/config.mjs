export function paymentConfig(env = process.env) {
  if (env.CAMPUS_PAYMENTS_ENABLED !== "1") return { enabled: false };
  if (
    !/^[0-9a-f-]{36}$/.test(env.CAMPUS_PAYMENT_ENVIRONMENT_ID ?? "") ||
    !/^acct_[A-Za-z0-9]+$/.test(env.CAMPUS_STRIPE_PLATFORM_ACCOUNT_ID ?? "") ||
    !["sandbox", "live"].includes(env.CAMPUS_PAYMENT_MODE)
  )
    throw Error("Invalid payment environment");
  const mode = env.CAMPUS_PAYMENT_MODE;
  if (
    !new RegExp("^[sr]k_" + (mode === "live" ? "live" : "test") + "_").test(
      env.CAMPUS_STRIPE_KEY ?? "",
    ) ||
    !env.CAMPUS_STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")
  )
    throw Error("Payment credentials are unavailable or incorrectly scoped");
  return {
    enabled: true,
    environment: {
      id: env.CAMPUS_PAYMENT_ENVIRONMENT_ID,
      platformAccountId: env.CAMPUS_STRIPE_PLATFORM_ACCOUNT_ID,
      mode,
    },
    secret: env.CAMPUS_STRIPE_KEY,
    snapshotSecret: env.CAMPUS_STRIPE_WEBHOOK_SECRET,
    thinSecret: env.CAMPUS_STRIPE_THIN_WEBHOOK_SECRET,
  };
}
