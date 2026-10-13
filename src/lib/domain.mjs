export const schools = {
  "berkeley.edu": "UC Berkeley",
  "stanford.edu": "Stanford",
  "mit.edu": "MIT",
  "ucla.edu": "UCLA",
  "harvard.edu": "Harvard",
  "columbia.edu": "Columbia",
};
export class DomainError extends Error {
  constructor(message, code = "INVALID_INPUT", status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function parseSchoolEmail(value) {
  if (typeof value !== "string" || value.length > 254)
    throw new DomainError("Enter your full university email address.");
  const match = value
    .trim()
    .match(/^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-zA-Z0-9.-]+)$/);
  if (!match || !Object.hasOwn(schools, match[2].toLowerCase()))
    throw new DomainError(
      "This demo supports the primary email domains of Berkeley, Stanford, MIT, UCLA, Harvard, and Columbia.",
      "SCHOOL_NOT_SUPPORTED",
    );
  const domain = match[2].toLowerCase();
  return { email: match[1] + "@" + domain, school: schools[domain], domain };
}
export function cents(value) {
  const text = String(value);
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text))
    throw new DomainError(
      "Enter an amount with no more than two decimal places.",
    );
  const [whole, fraction = ""] = text.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (result < 100 || result > 10_000_000)
    throw new DomainError("Amount must be between $1 and $100,000.");
  return result;
}
export function nextTaskState(state, action, role) {
  const routes = {
    open: { select: ["owner", "invited"], cancel: ["owner", "cancelled"] },
    invited: { accept: ["assignee", "active"], decline: ["assignee", "open"] },
    active: { submit: ["assignee", "review"] },
    review: { approve: ["owner", "completed"], revise: ["owner", "active"] },
  };
  const target = routes[state]?.[action];
  if (!target || target[0] !== role)
    throw new DomainError(
      "Your role or the current status does not allow this action.",
      "STATE_CONFLICT",
      409,
    );
  return target[1];
}
export function text(value, min = 1, max = 2000) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw new DomainError(`Enter ${min}–${max} characters.`);
  return value.trim();
}
