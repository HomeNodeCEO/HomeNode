import { useCallback, useEffect, useState } from "react";
import {
  analyzePropertyContext,
  getPropertyContextAssessment,
  savePropertyContextReview,
  type PropertyComplexityAssessment,
  type PropertyComplexityLevel,
} from "@/lib/api";

type ContextAnalysisOptions = {
  assignmentFileId?: number | null;
  customGeometry?: unknown;
  geography?: string | null;
};

type ContextReviewOptions = {
  assignmentFileId?: number | null;
};

type UsePropertyContextOptions = {
  accountId?: string;
  initialAssessment?: PropertyComplexityAssessment | null;
};

function contextCompletionMessage(assessment: PropertyComplexityAssessment): string {
  const stale = assessment.source_health.filter((source) => source.serving_stale_data);
  const unavailable = assessment.source_health.filter((source) => !source.usable);
  if (stale.length) {
    return "Analysis completed from the most recent locally stored data; one or more source synchronizations currently need attention.";
  }
  if (unavailable.length) {
    return "Core characteristics were analyzed. GIS factors will populate after the first county parcel and road synchronization.";
  }
  return "Property context and complexity screening updated from local data.";
}

export function usePropertyContext({
  accountId,
  initialAssessment = null,
}: UsePropertyContextOptions) {
  const [propertyContext, setPropertyContext] = useState<PropertyComplexityAssessment | null>(
    initialAssessment,
  );
  const [propertyContextLoading, setPropertyContextLoading] = useState(false);
  const [propertyContextSaving, setPropertyContextSaving] = useState(false);
  const [propertyContextMessage, setPropertyContextMessage] = useState("");
  const [propertyComplexityDraft, setPropertyComplexityDraft] = useState<PropertyComplexityLevel>(
    initialAssessment?.effective_complexity || "simple",
  );
  const [propertyComplexityNotes, setPropertyComplexityNotes] = useState(
    initialAssessment?.appraiser_notes || "",
  );

  const hydrateAssessment = useCallback((assessment: PropertyComplexityAssessment | null) => {
    setPropertyContext(assessment);
    setPropertyComplexityDraft(assessment?.effective_complexity || "simple");
    setPropertyComplexityNotes(assessment?.appraiser_notes || "");
  }, []);

  useEffect(() => {
    hydrateAssessment(initialAssessment);
    setPropertyContextMessage("");
  }, [accountId, hydrateAssessment, initialAssessment]);

  const loadAssessment = useCallback(async (
    assignmentFileId?: number | null,
    isCancelled: () => boolean = () => false,
  ) => {
    if (!accountId) return;
    try {
      const assessment = await getPropertyContextAssessment(accountId, assignmentFileId || null);
      if (isCancelled() || !assessment) return;
      hydrateAssessment(assessment);
    } catch {
      // The report remains usable; source notices appear when analysis is run.
    }
  }, [accountId, hydrateAssessment]);

  const analyzeCurrentPropertyContext = useCallback(async ({
    assignmentFileId = null,
    customGeometry = null,
    geography = null,
  }: ContextAnalysisOptions = {}) => {
    if (!accountId || propertyContextLoading) return;
    setPropertyContextLoading(true);
    setPropertyContextMessage("Analyzing locally stored property and neighborhood context...");
    try {
      const assessment = await analyzePropertyContext(accountId, {
        assignmentFileId,
        customGeometry,
        geography,
      });
      hydrateAssessment(assessment);
      setPropertyContextMessage(contextCompletionMessage(assessment));
    } catch (error) {
      setPropertyContextMessage(
        error instanceof Error ? error.message : "Property-context analysis could not be completed.",
      );
    } finally {
      setPropertyContextLoading(false);
    }
  }, [accountId, hydrateAssessment, propertyContextLoading]);

  const saveCurrentPropertyComplexity = useCallback(async ({
    assignmentFileId = null,
  }: ContextReviewOptions = {}) => {
    if (!accountId || !propertyContext || propertyContextSaving) return;
    setPropertyContextSaving(true);
    setPropertyContextMessage("");
    try {
      const assessment = await savePropertyContextReview(accountId, {
        assignmentFileId,
        complexity: propertyComplexityDraft,
        notes: propertyComplexityNotes,
      });
      hydrateAssessment(assessment);
      setPropertyContextMessage(
        assessment.review_status === "overridden"
          ? "Appraiser complexity override saved without changing the automated source evidence."
          : "Automated complexity recommendation reviewed and confirmed.",
      );
    } catch (error) {
      setPropertyContextMessage(
        error instanceof Error ? error.message : "The complexity review could not be saved.",
      );
    } finally {
      setPropertyContextSaving(false);
    }
  }, [accountId, hydrateAssessment, propertyComplexityDraft, propertyComplexityNotes, propertyContext, propertyContextSaving]);

  return {
    propertyContext,
    propertyContextLoading,
    propertyContextSaving,
    propertyContextMessage,
    propertyComplexityDraft,
    setPropertyComplexityDraft,
    propertyComplexityNotes,
    setPropertyComplexityNotes,
    hydrateAssessment,
    loadAssessment,
    analyzeCurrentPropertyContext,
    saveCurrentPropertyComplexity,
  };
}

export { contextCompletionMessage };
