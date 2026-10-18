"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { ApiError, request } from "./api";
import type { Agreement, Submission } from "./types";
import type {
  FulfillmentDraft,
  MilestoneReview,
  MilestoneSnapshot,
} from "./fulfillment-types";
export function useFulfillmentState(
  accountId: string,
  agreementId: string,
  milestoneId: string,
  revision?: number,
  termsIdentity?: string,
) {
  const storage = `campus:fulfillment-draft:${accountId}:${milestoneId}`;
  const [snapshot, setSnapshot] = useState<MilestoneSnapshot | null>(null);
  const [draft, setDraftState] = useState<FulfillmentDraft | null>(null);
  const draftRef = useRef<FulfillmentDraft | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<Error>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const before = await request<Agreement>(`agreements/${agreementId}`);
      const [submissions, reviews] = await Promise.all([
        request<Submission[]>(`milestones/${milestoneId}/submissions`),
        request<MilestoneReview[]>(`milestones/${milestoneId}/reviews`),
      ]);
      const agreement = await request<Agreement>(`agreements/${agreementId}`);
      if (current !== generation.current) return;
      const initial = before.milestones.find((m) => m.id === milestoneId);
      const milestone = agreement.milestones.find((m) => m.id === milestoneId);
      if (!milestone) throw new Error("This milestone is unavailable.");
      // Concurrent reads must describe the same latest version before enabling commands.
      const latest = submissions.at(-1);
      if (
        initial?.revision !== milestone.revision ||
        initial?.state !== milestone.state ||
        before.state !== agreement.state ||
        before.effectiveTerms?.id !== agreement.effectiveTerms?.id ||
        before.effectiveTerms?.revision !==
          agreement.effectiveTerms?.revision ||
        before.agreementTermsBinding !== agreement.agreementTermsBinding ||
        reviews.some((r) => r.milestone_revision > (milestone.revision ?? 0)) ||
        (latest?.version ?? 0) !== (milestone.version ?? 0) ||
        (milestone.latest_submission_id &&
          milestone.latest_submission_id !== latest?.id)
      )
        throw new Error(
          "The milestone changed while loading. Refresh to review its latest version.",
        );
      const submissionTermsId = latest?.submissionTermsId;
      const paymentBinding = agreement.transaction?.bindings?.find(
        (b) => b.terms_id === submissionTermsId,
      );
      const priorPaymentBinding = before.transaction?.bindings?.find(
        (b) => b.terms_id === submissionTermsId,
      );
      if (latest && agreement.transaction?.releasePolicy && !paymentBinding)
        throw new Error(
          "The submitted work’s financial binding is unavailable. Refresh before accepting it.",
        );
      if (
        JSON.stringify(paymentBinding) !== JSON.stringify(priorPaymentBinding)
      )
        throw new Error(
          "Financial terms changed while loading. Refresh the submitted work before reviewing it.",
        );
      const next = {
        milestone,
        submissions,
        reviews,
        agreementState: agreement.state,
        transactionTermsId: paymentBinding?.transaction_terms_id,
        transactionTermsRevision: paymentBinding?.transaction_terms_revision,
        effectiveTermsId: agreement.effectiveTerms?.id,
        effectiveRevision: agreement.effectiveTerms?.revision,
        binding: agreement.agreementTermsBinding,
      };
      setSnapshot(next);
      return next;
    } catch (cause) {
      if (
        current === generation.current &&
        cause instanceof ApiError &&
        [401, 403, 404].includes(cause.status)
      )
        setSnapshot(null);
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause
            : new Error("Could not load this milestone."),
        );
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [agreementId, milestoneId]);
  useEffect(() => {
    let restored: FulfillmentDraft | null = null;
    try {
      const raw = sessionStorage.getItem(storage);
      if (raw) restored = JSON.parse(raw);
    } catch {
      /* Optional draft recovery. */
    }
    draftRef.current = restored;
    setDraftState(restored);
  }, [storage]);
  function setDraft(action: SetStateAction<FulfillmentDraft | null>) {
    const next =
      typeof action === "function" ? action(draftRef.current) : action;
    draftRef.current = next;
    setDraftState(next);
    // Persist during the user action, not a mount effect that could erase a recovered draft.
    try {
      if (next) sessionStorage.setItem(storage, JSON.stringify(next));
      else sessionStorage.removeItem(storage);
    } catch {
      /* Editing remains available in memory. */
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, revision, termsIdentity]);
  function base(value = snapshot): FulfillmentDraft {
    return {
      transactionTermsId: value?.transactionTermsId,
      transactionTermsRevision: value?.transactionTermsRevision,
      effectiveTermsId: value?.effectiveTermsId,
      effectiveRevision: value?.effectiveRevision,
      binding: value?.binding,
      submissionTermsId: value?.submissions.at(-1)?.submissionTermsId,
      submissionTermsRevision:
        value?.submissions.at(-1)?.submissionTermsRevision,
      content: draft?.content ?? "",
      feedback: draft?.feedback ?? "",
      revision: value?.milestone.revision ?? 1,
      version: value?.milestone.version ?? 0,
      submissionId: value?.submissions.at(-1)?.id ?? null,
    };
  }
  function edit(field: "content" | "feedback", value: string) {
    setDraft((d) => ({ ...(d ?? base()), [field]: value }));
  }
  return { snapshot, draft, setDraft, loading, error, refresh, base, edit };
}
