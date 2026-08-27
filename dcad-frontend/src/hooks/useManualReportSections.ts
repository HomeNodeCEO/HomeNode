import { useCallback, useState } from "react";
import {
  updatePropertyReportSections,
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
  getEditorKey: () => string;
  onReload: () => Promise<void>;
  onCredentialRejected: () => void;
};

export function useManualReportSections({
  accountId,
  getEditorKey,
  onReload,
  onCredentialRejected,
}: UseManualReportSectionsOptions) {
  const [editingSection, setEditingSection] = useState<EditableReportSection | null>(null);
  const [savingSection, setSavingSection] = useState(false);

  const editSection = useCallback((key: ReportManualSectionKey) => {
    const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
    if (section) setEditingSection(section);
  }, []);

  const cancelEditingSection = useCallback(() => setEditingSection(null), []);

  const saveEditedSection = useCallback(async (value: Record<string, unknown>) => {
    if (!accountId || !editingSection || savingSection) return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setSavingSection(true);
    try {
      await updatePropertyReportSections(
        accountId,
        { [editingSection.key]: value },
        editorKey,
      );
      await onReload();
      setEditingSection(null);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "The report changes could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) onCredentialRejected();
      window.alert(message);
    } finally {
      setSavingSection(false);
    }
  }, [accountId, editingSection, getEditorKey, onCredentialRejected, onReload, savingSection]);

  return {
    editingSection,
    savingSection,
    editSection,
    cancelEditingSection,
    saveEditedSection,
  };
}
