import { useCallback, useState } from "react";
import {
  updatePropertyReportSections,
  type ReportManualValue,
  type ReportManualSectionKey,
} from "@/lib/api";
import type { EditableReportSection } from "@/components/ReportSectionEditor";

export const EDITABLE_REPORT_SECTIONS: EditableReportSection[] = [
  { key: "report.subject_identification", title: "Subject Identification" },
  { key: "report.exemptions", title: "Current Exemptions" },
  { key: "report.sales_history", title: "Listings, Contracts, and Sales History" },
  { key: "report.property_characteristics", title: "Property Characteristics" },
  { key: "report.land_details", title: "Land Details" },
  { key: "report.appraisal_values", title: "Appraisal District Values" },
];

type UseManualReportSectionsOptions = {
  accountId?: string;
  assignmentFileId?: number | null;
  getRevision: (key: ReportManualSectionKey) => number;
  getEditorKey: () => string;
  onReload: () => Promise<void>;
  onSaved?: (
    values: Partial<Record<ReportManualSectionKey, ReportManualValue>>,
  ) => void;
  onConflict?: () => Promise<void>;
  onCredentialRejected: () => void;
};

export function useManualReportSections({
  accountId,
  assignmentFileId,
  getRevision,
  getEditorKey,
  onReload,
  onSaved,
  onConflict,
  onCredentialRejected,
}: UseManualReportSectionsOptions) {
  const [editingSection, setEditingSection] = useState<EditableReportSection | null>(null);
  const [editingRevision, setEditingRevision] = useState(0);
  const [savingSection, setSavingSection] = useState(false);

  const editSection = useCallback((key: ReportManualSectionKey) => {
    const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
    if (section) {
      setEditingSection(section);
      setEditingRevision(getRevision(key));
    }
  }, [getRevision]);

  const cancelEditingSection = useCallback(() => {
    setEditingSection(null);
    setEditingRevision(0);
  }, []);

  const saveEditedSection = useCallback(async (value: Record<string, unknown>) => {
    if (!accountId || !editingSection || savingSection) return;
    if (!assignmentFileId) {
      window.alert("Choose or start a Custom Appraisal assignment file before saving report edits.");
      return;
    }
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setSavingSection(true);
    try {
      const response = await updatePropertyReportSections(
        accountId,
        { [editingSection.key]: value },
        editorKey,
        assignmentFileId,
        { [editingSection.key]: editingRevision },
      );
      onSaved?.(response.manual_values);
      await onReload();
      setEditingSection(null);
      setEditingRevision(0);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The report changes could not be saved.";
      const revisionConflict = /409|report_section_revision_conflict/i.test(message);
      if (revisionConflict) {
        await onConflict?.().catch(() => {});
        setEditingSection(null);
        setEditingRevision(0);
      }
      if (/401|invalid_editor_key/i.test(message)) onCredentialRejected();
      window.alert(revisionConflict
        ? "This report section changed after you opened it. The latest assignment revision was loaded; reopen the section and review before saving."
        : message);
    } finally {
      setSavingSection(false);
    }
  }, [
    accountId,
    assignmentFileId,
    editingSection,
    editingRevision,
    getEditorKey,
    onConflict,
    onCredentialRejected,
    onReload,
    onSaved,
    savingSection,
  ]);

  return {
    editingSection,
    savingSection,
    editSection,
    cancelEditingSection,
    saveEditedSection,
  };
}
