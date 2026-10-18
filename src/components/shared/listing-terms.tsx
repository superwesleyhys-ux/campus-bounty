import { money } from "./types";
import type { ListingTerms } from "./listing-types";
const names: Record<string, string> = {
  title: "Title",
  releasePolicy: "Release policy",
  fullUpfront: "Full upfront funding required",
  transactionDisclosureVersion: "Fee disclosure",
  description: "Description",
  category: "Category",
  rewardCents: "Total reward",
  dueDate: "Target delivery date",
  priceCents: "Price per item",
  stock: "Available stock",
  deliveryMethods: "Delivery methods",
  shippingCents: "Shipping per order",
  milestones: "Milestones",
};
function value(key: string, v: unknown): string {
  if (v === undefined || v === null || v === "") return "Not specified";
  if (key === "releasePolicy")
    return v === "per_milestone"
      ? "After each accepted milestone"
      : "After final completion";
  if (key === "transactionDisclosureVersion")
    return "Platform fee $0; processing fee shared 50/50; recipient half follows confirmed reward ratios; publisher pays odd cent.";
  if (key.endsWith("Cents")) return money(v as number);
  if (key === "milestones")
    return (v as Extract<ListingTerms, { milestones: unknown }>["milestones"])
      .map(
        (m, i) =>
          `${i + 1}. ${m.title} · ${money(m.amountCents)}\nDeliverable: ${m.deliverable}\nAcceptance criteria: ${m.acceptanceCriteria || "Not specified"}`,
      )
      .join("\n\n");
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
export function TermsView({ terms }: { terms: ListingTerms }) {
  return (
    <dl className="cb-listing-terms">
      {Object.entries(terms).map(([k, v]) => (
        <div key={k}>
          <dt>{names[k] || k}</dt>
          <dd className="cb-prewrap">{value(k, v)}</dd>
        </div>
      ))}
    </dl>
  );
}
export function TermsComparison({
  before,
  after,
}: {
  before: ListingTerms;
  after: ListingTerms;
}) {
  const changes = Object.keys(after).filter(
    (k) =>
      JSON.stringify(before[k as keyof ListingTerms]) !==
      JSON.stringify(after[k as keyof ListingTerms]),
  );
  return changes.length ? (
    <div className="cb-listing-changes">
      {changes.map((k) => (
        <section key={k}>
          <h3>{names[k] || k}</h3>
          <div>
            <strong>Before</strong>
            <p className="cb-prewrap">
              {value(k, (before as unknown as Record<string, unknown>)[k])}
            </p>
          </div>
          <div>
            <strong>After</strong>
            <p className="cb-prewrap">
              {value(k, (after as unknown as Record<string, unknown>)[k])}
            </p>
          </div>
        </section>
      ))}
    </div>
  ) : (
    <p>No term changes.</p>
  );
}
