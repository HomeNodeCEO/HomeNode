import { useCallback, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useManualReportSections } from "@/hooks/useManualReportSections";
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
}: {
  accountId?: string;
  baseDetail: LegacyDcadDetail | null;
  activeAssignmentFile: AppraisalAssignmentFile | null;
  setActiveAssignmentFile: Dispatch<SetStateAction<AppraisalAssignmentFile | null>>;
  setAssignmentFiles: Dispatch<SetStateAction<AppraisalAssignmentFile[]>>;
  getEditorKey: () => string;
  onReload: () => Promise<void>;
  onCredentialRejected: () => void;
}) {
  const assignmentManualValues = useMemo(() => ({
    ...(baseDetail?.report_manual_values || {}),
    ...Object.fromEntries(
      Object.entries(activeAssignmentFile?.custom_appraisal_sections || {}).map(([key, section]) => [
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
  }), [activeAssignmentFile?.custom_appraisal_sections, baseDetail?.report_manual_values]);
  const detail = useMemo(() => baseDetail
    ? applyReportManualValues(baseDetail, assignmentManualValues)
    : null, [assignmentManualValues, baseDetail]);

  const handleSaved = useCallback((
    values: Partial<Record<ReportManualSectionKey, ReportManualValue>>,
  ) => {
    const updateFile = (file: AppraisalAssignmentFile): AppraisalAssignmentFile => {
      const sections = { ...(file.custom_appraisal_sections || {}) };
      for (const [key, saved] of Object.entries(values)) {
        if (!saved || !saved.value || typeof saved.value !== "object" || Array.isArray(saved.value)) {
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
    setActiveAssignmentFile((current) => current ? updateFile(current) : current);
    setAssignmentFiles((current) => current.map((file) => (
      file.id === activeAssignmentFile?.id ? updateFile(file) : file
    )));
  }, [activeAssignmentFile?.id, setActiveAssignmentFile, setAssignmentFiles]);
  const getRevision = useCallback((key: ReportManualSectionKey) => Number(
    activeAssignmentFile?.custom_appraisal_sections?.[key]?.revision || 0,
  ), [activeAssignmentFile?.custom_appraisal_sections]);
  const handleConflict = useCallback(async () => {
    if (!accountId || !activeAssignmentFile?.id) return;
    const response = await getAssignmentFiles(accountId, activeAssignmentFile.id);
    const refreshed = response.files.find((file) => file.id === activeAssignmentFile.id);
    if (!refreshed) return;
    setAssignmentFiles(response.files);
    setActiveAssignmentFile(refreshed);
  }, [accountId, activeAssignmentFile?.id, setActiveAssignmentFile, setAssignmentFiles]);

  const editor = useManualReportSections({
    accountId,
    assignmentFileId: activeAssignmentFile?.id || null,
    getRevision,
    getEditorKey,
    onReload,
    onSaved: handleSaved,
    onConflict: handleConflict,
    onCredentialRejected,
  });

  return { detail, ...editor };
}
