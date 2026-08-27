import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPropertyZoningEvidence,
  getZoningDocumentDescriptionSuggestion,
  savePropertyZoningVerification,
  type PropertyZoningEvidence,
} from "@/lib/api";
import {
  EMPTY_ZONING_EVIDENCE_DRAFT,
  zoningDraftFromEvidence,
  type ZoningEvidenceDraft,
} from "@/lib/zoningEvidencePresentation";

const zoningEvidenceRequests = new Map<string, Promise<PropertyZoningEvidence>>();

function loadSharedZoningEvidence(
  accountId: string,
  assignmentFileId?: number | null,
): Promise<PropertyZoningEvidence> {
  const key = `${accountId}:${assignmentFileId || "unfiled"}`;
  const existing = zoningEvidenceRequests.get(key);
  if (existing) return existing;
  const request = getPropertyZoningEvidence(accountId, assignmentFileId || null)
    .then((response) => response.evidence)
    .finally(() => {
      if (zoningEvidenceRequests.get(key) === request) zoningEvidenceRequests.delete(key);
    });
  zoningEvidenceRequests.set(key, request);
  return request;
}

export function useZoningEvidence({
  accountId,
  assignmentFileId,
  enabled,
  getEditorKey,
  onCredentialRejected,
}: {
  accountId?: string;
  assignmentFileId?: number | null;
  enabled: boolean;
  getEditorKey: () => string;
  onCredentialRejected: () => void;
}) {
  const [zoningEvidence, setZoningEvidence] = useState<PropertyZoningEvidence | null>(null);
  const [zoningEvidenceOpen, setZoningEvidenceOpen] = useState(false);
  const [zoningEvidenceLoading, setZoningEvidenceLoading] = useState(false);
  const [zoningEvidenceMessage, setZoningEvidenceMessage] = useState("");
  const [zoningDraft, setZoningDraft] = useState<ZoningEvidenceDraft>(
    EMPTY_ZONING_EVIDENCE_DRAFT,
  );
  const requestVersionRef = useRef(0);
  const editorKeyRef = useRef(getEditorKey);
  const credentialRejectedRef = useRef(onCredentialRejected);

  useEffect(() => {
    editorKeyRef.current = getEditorKey;
  }, [getEditorKey]);
  useEffect(() => {
    credentialRejectedRef.current = onCredentialRejected;
  }, [onCredentialRejected]);

  const hydrateZoningEvidence = useCallback((evidence: PropertyZoningEvidence) => {
    setZoningEvidence(evidence);
    setZoningDraft((current) => zoningDraftFromEvidence(evidence, current));
  }, []);

  const loadZoningEvidence = useCallback(async ({ open = false } = {}) => {
    if (!accountId || !enabled) return;
    if (open) setZoningEvidenceOpen(true);
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const evidence = await loadSharedZoningEvidence(accountId, assignmentFileId);
      if (requestVersion !== requestVersionRef.current) return;
      hydrateZoningEvidence(evidence);
    } catch (error) {
      if (requestVersion === requestVersionRef.current) {
        setZoningEvidenceMessage(
          error instanceof Error ? error.message : "Zoning evidence could not be loaded.",
        );
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setZoningEvidenceLoading(false);
    }
  }, [accountId, assignmentFileId, enabled, hydrateZoningEvidence]);

  useEffect(() => {
    requestVersionRef.current += 1;
    if (!enabled || !accountId) {
      setZoningEvidenceLoading(false);
      return;
    }
    void loadZoningEvidence();
  }, [accountId, assignmentFileId, enabled, loadZoningEvidence]);

  const saveZoningEvidence = useCallback(async () => {
    if (!accountId || !zoningEvidence?.jurisdiction) return;
    if (!zoningDraft.zoningCode.trim()) {
      setZoningEvidenceMessage("Enter the confirmed zoning code before saving.");
      return;
    }
    if (!zoningDraft.zoningDescription.trim()) {
      setZoningEvidenceMessage("Enter or prefill the exact official zoning description before saving.");
      return;
    }
    if (!zoningDraft.reviewer.trim()) {
      setZoningEvidenceMessage("Enter the appraiser or reviewer name before saving.");
      return;
    }
    const editorKey = editorKeyRef.current();
    if (!editorKey) return;
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const response = await savePropertyZoningVerification(
        accountId,
        {
          assignment_file_id: assignmentFileId || null,
          jurisdiction_city: zoningEvidence.jurisdiction.city,
          source_document_id: zoningDraft.sourceDocumentId
            ? Number(zoningDraft.sourceDocumentId)
            : null,
          source_type: zoningDraft.sourceType,
          zoning_code: zoningDraft.zoningCode.trim(),
          zoning_description: zoningDraft.zoningDescription.trim(),
          page_number: zoningDraft.pageNumber ? Number(zoningDraft.pageNumber) : null,
          confirmation_reference: zoningDraft.confirmationReference.trim(),
          notes: zoningDraft.notes.trim(),
          reviewer: zoningDraft.reviewer.trim(),
        },
        editorKey,
      );
      hydrateZoningEvidence({
        ...zoningEvidence,
        review_required: false,
        verification: response.verification,
      });
      setZoningEvidenceMessage("Confirmed zoning and source provenance saved to this property file.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The zoning verification could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) credentialRejectedRef.current();
      setZoningEvidenceMessage(message);
    } finally {
      setZoningEvidenceLoading(false);
    }
  }, [accountId, assignmentFileId, hydrateZoningEvidence, zoningDraft, zoningEvidence]);

  const prefillVerbatimZoningDescription = useCallback(async () => {
    const sourceDocument = zoningEvidence?.documents.find(
      (document) => String(document.id) === zoningDraft.sourceDocumentId,
    ) || zoningEvidence?.documents[0] || null;
    if (!sourceDocument || !zoningDraft.zoningCode.trim()) {
      setZoningEvidenceMessage("Select an official PDF and enter the zoning code first.");
      return;
    }
    setZoningEvidenceLoading(true);
    setZoningEvidenceMessage("");
    try {
      const result = await getZoningDocumentDescriptionSuggestion(
        sourceDocument.id,
        zoningDraft.zoningCode.trim(),
      );
      if (!result.suggestion?.raw_value) {
        setZoningEvidenceMessage(
          "That code was not found beside a reliable description in the PDF text layer. Review the visible document and city contact before confirming.",
        );
        return;
      }
      setZoningDraft((current) => ({
        ...current,
        zoningDescription: result.suggestion?.raw_value || current.zoningDescription,
        pageNumber: result.suggestion?.page_number
          ? String(result.suggestion.page_number)
          : current.pageNumber,
      }));
      setZoningEvidenceMessage(
        `Prefilled the exact wording found on PDF page ${result.suggestion.page_number || "unknown"}. Appraiser confirmation is still required.`,
      );
    } catch (error) {
      setZoningEvidenceMessage(
        error instanceof Error ? error.message : "The zoning description could not be suggested.",
      );
    } finally {
      setZoningEvidenceLoading(false);
    }
  }, [zoningDraft.sourceDocumentId, zoningDraft.zoningCode, zoningEvidence]);

  return {
    zoningEvidence,
    zoningEvidenceOpen,
    setZoningEvidenceOpen,
    zoningEvidenceLoading,
    zoningEvidenceMessage,
    zoningDraft,
    setZoningDraft,
    loadZoningEvidence,
    saveZoningEvidence,
    prefillVerbatimZoningDescription,
  };
}
