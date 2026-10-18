import type { Task, Product, Application } from "./types";
export type ListingKind = "task" | "product";
export type TaskTerms = {
  releasePolicy?: "per_milestone" | "final_completion" | null;
  title: string;
  description: string;
  category: string;
  rewardCents: number;
  dueDate: string | null;
  milestones: {
    title: string;
    deliverable: string;
    acceptanceCriteria: string | null;
    amountCents: number;
  }[];
};
export type ProductTerms = {
  title: string;
  description: string;
  priceCents: number;
  stock: number;
  deliveryMethods: string[];
  shippingCents: number;
};
export type ListingTerms = TaskTerms | ProductTerms;
export type ListingVersion = {
  kind: ListingKind;
  listing_id: string;
  version: number;
  terms: ListingTerms;
  provenance: string;
  created_at: string;
};
export type ListingReceipt = {
  id: string;
  kind: ListingKind;
  operation: string;
  revision: number;
  termsVersion: number;
  visibility: string;
};
export type CommandResult<R, C> = { receipt: R; replayed: boolean; current: C };
export type ApplicationTerms = {
  application: Omit<Application, "members"> & {
    submitted_version: number;
    provenance: string;
  };
  listing: Task;
  versions: ListingVersion[];
  members: Application["members"];
  acknowledgements: {
    user_id: string;
    version: number;
    acknowledged_at: string;
  }[];
  invitations: Invitation[];
  missingAcknowledgements: string[];
  currentInvitation: Invitation | null;
  reviewRequired: boolean;
  legacyProvenance: boolean;
};
export type Invitation = {
  version: number;
  task_revision: number;
  publisher_id: string;
  created_at: string;
};
export type ApplicationReceipt = {
  id: string;
  operation: string;
  termsVersion?: number;
  revision?: number;
  agreementId?: string | null;
  originalAgreement?: boolean;
};
export type Listing = Task | Product;
export const listingPath = (kind: ListingKind, id: string) =>
  `${kind === "task" ? "tasks" : "products"}/${id}`;
export function currentTerms(row: Listing): ListingTerms {
  return "owner_id" in row
    ? {
        title: row.title,
        description: row.description,
        category: row.category,
        rewardCents: row.reward_cents,
        dueDate: row.due_date || null,
        ...(row.release_policy ? { releasePolicy: row.release_policy } : {}),
        milestones: row.milestones.map((m) => ({
          title: m.title,
          deliverable: m.deliverable,
          acceptanceCriteria: m.acceptance_criteria ?? null,
          amountCents: m.amount_cents,
        })),
      }
    : {
        title: row.title,
        description: row.description,
        priceCents: row.price_cents,
        stock: row.stock,
        deliveryMethods: row.delivery_methods,
        shippingCents: row.shipping_cents,
      };
}
