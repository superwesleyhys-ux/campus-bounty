// Parse decimal dollars without floating-point rounding or silent truncation.
export function dollarsToCents(value, { zero = false, max = 100000000 } = {}) {
  if (typeof value !== "string" || !/^\d{1,7}(\.\d{1,2})?$/.test(value.trim()))
    throw new Error("Use a dollar amount with up to two decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < (zero ? 0 : 1) || cents > max)
    throw new Error("This amount is outside the supported range.");
  return cents;
}
