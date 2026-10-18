import type { StageTerms, TermsSnapshot } from "./amendment-types";
export type Account = {
  id: string;
  display_name: string;
  account_status: string;
  campus_verified: boolean;
  can_apply: boolean;
  affiliation_valid_until: string;
  bio: string;
  institution_id: string | null;
  institution_name: string | null;
  student_valid_until: string | null;
  can_review_eligibility: boolean;
};
export type Milestone = {
  effectiveTerms?: StageTerms | null;
  lifecycle?: "included" | "retired";
  protectedWork?: boolean;
  id: string;
  title: string;
  deliverable: string;
  acceptance_criteria?: string | null;
  amount_cents: number;
  position: number;
  state?: string;
  version?: number;
  revision?: number;
  latest_submission_id?: string | null;
  accepted_submission_id?: string | null;
};
export type Task = {
  release_policy?: "per_milestone" | "final_completion" | null;
  visibility: "published" | "paused";
  terms_version: number;
  id: string;
  owner_id: string;
  title: string;
  category: string;
  description: string;
  due_date?: string | null;
  reward_cents: number;
  status: string;
  related_agreement?: { id: string; state: string } | null;
  revision: number;
  created_at: string;
  milestones: Milestone[];
};
export type Product = {
  visibility: "published" | "paused";
  terms_version: number;
  revision: number;
  stock_revision: number;
  id: string;
  seller_id: string;
  title: string;
  description: string;
  price_cents: number;
  stock: number;
  delivery_methods: string[];
  shipping_cents: number;
  created_at: string;
};
export type TeamContext = {
  purpose: string;
  activities: string;
  timeCommitment: string;
  projectContext: string;
};
export type Team = {
  id: string;
  owner_id: string | null;
  name: string;
  revision: number;
  status: "active" | "archived";
  archived_at: string | null;
  can_view_roster: boolean;
  context: TeamContext | null;
  own_state:
    "invited" | "accepted" | "declined" | "revoked" | "left" | "removed";
  members: {
    user_id: string;
    display_name?: string;
    state: Team["own_state"];
    can_captain?: boolean;
  }[];
};
export type Application = {
  id: string;
  task_id: string;
  applicant_id: string;
  team_id: string | null;
  proposal: string;
  state: string;
  task_title?: string;
  members: { user_id: string; display_name?: string; confirmed: boolean }[];
};
export type Agreement = {
  transaction?: {
    releasePolicy: string | null;
    provenance: string;
    allocations?: {
      member_id: string;
      stage_position: number;
      gross_cents: number;
      recipient_fee_cents: number;
      net_cents: number;
    }[];
  };
  agreementAmendments?: boolean;
  agreementTermsBinding?: "legacy" | "explicit";
  originalTerms?: TermsSnapshot;
  effectiveTerms?: TermsSnapshot;
  currentRewardCents?: number;
  amendmentSummary?: {
    id: string;
    proposalRevision: number;
    status: string;
  } | null;
  milestone_counts?: {
    pending: number;
    submitted: number;
    revision_requested: number;
    accepted: number;
    total: number;
  };
  id: string;
  task_id: string;
  owner_id: string;
  captain_id: string;
  state: string;
  terms: {
    taskTitle: string;
    description: string;
    rewardCents: number;
    dueDate?: string | null;
  };
  members: { user_id: string }[];
  milestones: Milestone[];
};
export type Quote = {
  id: string;
  quantity: number;
  unit_cents: number;
  shipping_cents: number;
  delivery_method: string;
  expires_at: string;
};
export type Order = {
  id: string;
  product_id: string;
  buyer_id: string;
  seller_id: string;
  total_cents: number;
  state: string;
  delivery_method: string;
  reserved_until: string;
  quantity: number;
  terms: { title: string; unitCents: number; shippingCents: number };
  shipping_address?: Record<string, string>;
  carrier?: string;
  tracking_number?: string;
};
export type Submission = {
  submissionTermsId?: string;
  submissionTermsRevision?: number;
  submissionTerms?: TermsSnapshot;
  milestoneTerms?: StageTerms;
  id: string;
  content: string;
  version: number;
  created_at: string;
  author_id: string;
};
export type Message = {
  id: string;
  body: string;
  sender_id: string;
  created_at: string;
};
export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};
export const categories = [
  "Research",
  "Design",
  "Engineering",
  "Writing",
  "Campus",
  "Other",
];
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export const label = (state: string) => state.replaceAll("_", " ");

export type HistoryScope =
  "applications" | "agreements" | "orders" | "posted" | "selling" | "saved";
export type HistoryPage<T> = {
  scope: HistoryScope;
  items: T[];
  limit: number;
  nextCursor: string | null;
};
