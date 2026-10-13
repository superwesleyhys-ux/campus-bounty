import type { Agreement, Milestone, Submission } from "./types";
export type MilestoneReview = {
  id: string;
  milestone_id: string;
  submission_id: string;
  submission_version: number;
  milestone_revision: number;
  reviewer_id: string;
  decision: "revision_requested" | "accepted";
  feedback: string;
  created_at: string;
};
export type FulfillmentResult = {
  milestone?: Milestone;
  submission?: Submission | null;
  agreement: Pick<Agreement, "id" | "state">;
  receipt: {
    operation: "submit" | "revision_requested" | "accepted" | "completed";
    submissionId?: string;
    reviewId?: string;
    agreementId?: string;
  };
};
export type MilestoneSnapshot = {
  milestone: Milestone;
  submissions: Submission[];
  reviews: MilestoneReview[];
  agreementState: string;
};
export type FulfillmentDraft = {
  content: string;
  feedback: string;
  revision: number;
  version: number;
  submissionId: string | null;
};
