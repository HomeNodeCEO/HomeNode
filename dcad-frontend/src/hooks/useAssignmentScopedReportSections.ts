import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import { manualReportValuesForUi, useManualReportSections, type ReportSectionSelectionRef } from "@/hooks/useManualReportSections";
import { customAssignmentFileMatches } from "@/lib/customAssignmentNavigation";
import {
  getAssignmentFiles,
  type AppraisalAssignmentFile,
  type ReportManualSectionKey,
  type ReportManualValue,
} from "@/lib/api";
import {
  applyReportManualValues,
  type LegacyDcadDetail,
} from "@/lib/legacyDcadDetail";

function retainNewerSections(current: AppraisalAssignmentFile, incoming: AppraisalAssignmentFile): AppraisalAssignmentFile {
  const sections = { ...incoming.custom_appraisal_sections };
  let retained = false;
  for (const [key, section] of Object.entries(current.custom_appraisal_sections || {})) {
    if (!sections[key] || section.revision >= sections[key].revision) {
      sections[key] = section;
      retained = true;
    }
  }
  return retained ? { ...incoming, custom_appraisal_sections: sections } : incoming;
}

/*
 * The account response is deliberately public-data only in enforced mode. These
 * edits are overlaid from the exact assignment selected by the authenticated user.
 */

export function useAssignmentScopedReportSections({
  accountId,
  baseDetail,
  activeAssignmentFile,
  setActiveAssignmentFile,
  setAssignmentFiles,
  getEditorKey,
  onReload,
  onCredentialRejected,
  readOnly = false,
  selectionGenerationRef,
}: {
  accountId?: string;
  baseDetail: LegacyDcadDetail | null;
  activeAssignmentFile: AppraisalAssignmentFile | null;
  setActiveAssignmentFile: Dispatch<SetStateAction<AppraisalAssignmentFile | null>>;
  setAssignmentFiles: Dispatch<SetStateAction<AppraisalAssignmentFile[]>>;
  getEditorKey: () => string;
  onReload: () => Promise<void>;
  onCredentialRejected: () => void;
  readOnly?: boolean;
  selectionGenerationRef?: ReportSectionSelectionRef;
}) {
  const selectedFile = customAssignmentFileMatches(activeAssignmentFile, accountId || "") ? activeAssignmentFile : null;
  const assignmentFileId = selectedFile?.id || null;
  const selectionGeneration = selectionGenerationRef?.current;
  const owner = useMemo(() => ({ accountId, assignmentFileId, selectionGeneration }), [accountId, assignmentFileId, selectionGeneration]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const scopeIsCurrent = useCallback(() => mountedRef.current && ownerRef.current === owner && !readOnlyRef.current
    && selectionGenerationRef?.current === owner.selectionGeneration, [owner, selectionGenerationRef]);
  const assignmentManualValues = useMemo(() => ({
    ...manualReportValuesForUi(baseDetail?.report_manual_values),
    ...Object.fromEntries(
      Object.entries(manualReportValuesForUi(selectedFile?.custom_appraisal_sections)).map(([key, section]) => [
        key,
        {
          value: section.value,
          revision: section.revision,
          reviewer: null,
          notes: null,
          updated_at: section.updated_at,
        },
      ]),
    ),
  }), [selectedFile?.custom_appraisal_sections, baseDetail?.report_manual_values]);
  const detail = useMemo(() => baseDetail
    ? applyReportManualValues(baseDetail, assignmentManualValues, {
      explicitSubjectValues: Object.hasOwn(selectedFile?.custom_appraisal_sections || {}, "report.subject_identification"),
    })
    : null, [assignmentManualValues, baseDetail, selectedFile?.custom_appraisal_sections]);

  const handleSaved = useCallback((
    values: Partial<Record<ReportManualSectionKey, ReportManualValue>>,
    requestIsCurrent: () => boolean = () => true,
  ) => {
    const canApply = () => scopeIsCurrent() && requestIsCurrent();
    if (!canApply() || !accountId || !assignmentFileId) return;
    const updateFile = (file: AppraisalAssignmentFile): AppraisalAssignmentFile => {
      if (file.id !== assignmentFileId || !customAssignmentFileMatches(file, accountId)) return file;
      const sections = { ...(file.custom_appraisal_sections || {}) };
      for (const [key, saved] of Object.entries(manualReportValuesForUi(values))) {
        if (!saved || !saved.value || typeof saved.value !== "object" || Array.isArray(saved.value)
          || !Number.isSafeInteger(saved.revision) || saved.revision < 1
          || (sections[key] && saved.revision <= sections[key].revision)) {
          continue;
        }
        sections[key] = {
          value: saved.value as Record<string, unknown>,
          revision: saved.revision,
          last_applied_session_id: null,
          updated_at: saved.updated_at,
        };
      }
      return { ...file, custom_appraisal_sections: sections };
    };
    // Acknowledged updates may commit after the editor closes, but never after selection changes.
    setActiveAssignmentFile((current) => scopeIsCurrent() && current ? updateFile(current) : current);
    setAssignmentFiles((current) => scopeIsCurrent() ? current.map(updateFile) : current);
  }, [accountId, assignmentFileId, scopeIsCurrent, setActiveAssignmentFile, setAssignmentFiles]);
  const getRevision = useCallback((key: ReportManualSectionKey) => Number(
    selectedFile?.custom_appraisal_sections?.[key]?.revision || 0,
  ), [selectedFile?.custom_appraisal_sections]);
  const handleConflict = useCallback(async (requestIsCurrent: () => boolean = () => true) => {
    const canApply = () => scopeIsCurrent() && requestIsCurrent();
    if (!canApply() || !accountId || !assignmentFileId) return;
    const response = await getAssignmentFiles(accountId, assignmentFileId);
    if (!canApply()) return;
    const refreshed = response.files.find((file) => file.id === assignmentFileId && customAssignmentFileMatches(file, accountId));
    if (!refreshed || typeof response.account_id !== "string" || response.account_id.trim().toUpperCase() !== accountId.trim().toUpperCase()) {
      throw new Error("The selected assignment could not be reloaded.");
    }
    setAssignmentFiles((current) => scopeIsCurrent() ? response.files.filter(file => customAssignmentFileMatches(file, accountId)).map(file => {
      const existing = current.find(item => item.id === file.id && customAssignmentFileMatches(item, accountId));
      return existing ? retainNewerSections(existing, file) : file;
    }) : current);
    setActiveAssignmentFile((current) => scopeIsCurrent() && current?.id === assignmentFileId && customAssignmentFileMatches(current, accountId)
      ? retainNewerSections(current, refreshed) : current);
  }, [accountId, assignmentFileId, scopeIsCurrent, setActiveAssignmentFile, setAssignmentFiles]);

  const editor = useManualReportSections({
    accountId,
    assignmentFileId,
    readOnly,
    selectionGenerationRef,
    getRevision,
    getEditorKey,
    onReload,
    onSaved: handleSaved,
    onConflict: handleConflict,
    onCredentialRejected,
  });

  return { detail, ...editor };
}
