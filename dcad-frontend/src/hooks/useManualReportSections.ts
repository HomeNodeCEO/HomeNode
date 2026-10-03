import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const UI_MANUAL_SECTION_KEYS = new Set<string>([
  ...EDITABLE_REPORT_SECTIONS.map(section => section.key),
  "report.assignment_details",
]);

export function manualReportValuesForUi(values: unknown): Partial<Record<ReportManualSectionKey, ReportManualValue>> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => UI_MANUAL_SECTION_KEYS.has(key)
    && value && typeof value === "object" && !Array.isArray(value)));
}

export type ReportSectionSelectionRef = { readonly current: number };
type OperationGuard = () => boolean;

type UseManualReportSectionsOptions = {
  accountId?: string;
  assignmentFileId?: number | null;
  readOnly?: boolean;
  selectionGenerationRef?: ReportSectionSelectionRef;
  getRevision: (key: ReportManualSectionKey) => number;
  getEditorKey: () => string;
  onReload: () => Promise<void>;
  onSaved?: (
    values: Partial<Record<ReportManualSectionKey, ReportManualValue>>,
    isCurrent?: OperationGuard,
  ) => void;
  onConflict?: (isCurrent?: OperationGuard) => Promise<void>;
  onCredentialRejected: () => void;
};

export function useManualReportSections({
  accountId,
  assignmentFileId,
  readOnly = false,
  selectionGenerationRef,
  getRevision,
  getEditorKey,
  onReload,
  onSaved,
  onConflict,
  onCredentialRejected,
}: UseManualReportSectionsOptions) {
  const selectionGeneration = selectionGenerationRef?.current;
  const owner = useMemo(() => ({ accountId, assignmentFileId, selectionGeneration,
    key: JSON.stringify([accountId, assignmentFileId]) }), [accountId, assignmentFileId, selectionGeneration]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const mountedRef = useRef(true);
  const nextSessionId = useRef(0);
  type EditingSession = { owner: typeof owner; section: EditableReportSection; revision: number; key: string };
  const [session, setSession] = useState<EditingSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const pendingSavesRef = useRef(new Set<EditingSession>());
  const [pendingSaves, setPendingSaves] = useState<EditingSession[]>([]);
  const ownerIsCurrent = useCallback(() => mountedRef.current && ownerRef.current === owner
    && selectionGenerationRef?.current === owner.selectionGeneration, [owner, selectionGenerationRef]);
  const editingSession = ownerIsCurrent() && !readOnly && session?.owner === owner ? session : null;
  const savingSection = pendingSaves.some(pending => pending.owner.key === owner.key);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; sessionRef.current = null; };
  }, []);
  useLayoutEffect(() => {
    sessionRef.current = null;
    setSession(null);
  }, [owner, readOnly]);

  const editSection = useCallback((key: ReportManualSectionKey) => {
    if (!ownerIsCurrent() || readOnlyRef.current || [...pendingSavesRef.current].some(pending => pending.owner.key === owner.key)) return;
    const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
    if (section) {
      const next = { owner, section, revision: getRevision(key), key: `${owner.key}:${++nextSessionId.current}` };
      sessionRef.current = next;
      setSession(next);
    }
  }, [getRevision, owner, ownerIsCurrent]);

  const cancelEditingSection = useCallback(() => {
    if (!ownerIsCurrent() || sessionRef.current !== editingSession) return;
    sessionRef.current = null;
    setSession(null);
  }, [editingSession, ownerIsCurrent]);

  const saveEditedSection = useCallback(async (value: Record<string, unknown>) => {
    if (!ownerIsCurrent() || readOnlyRef.current || !accountId || !editingSession
      || sessionRef.current !== editingSession || [...pendingSavesRef.current].some(pending => pending.owner.key === owner.key)) return;
    if (!Number.isSafeInteger(assignmentFileId) || !assignmentFileId || assignmentFileId < 1) {
      window.alert("Choose or start a Custom Appraisal assignment file before saving report edits.");
      return;
    }
    const editorKey = getEditorKey();
    if (!editorKey) return;
    const requestIsCurrent = () => ownerIsCurrent() && !readOnlyRef.current && sessionRef.current === editingSession;
    if (!requestIsCurrent()) return;
    pendingSavesRef.current.add(editingSession);
    setPendingSaves([...pendingSavesRef.current]);
    try {
      const response = await updatePropertyReportSections(
        accountId,
        { [editingSession.section.key]: value },
        editorKey,
        assignmentFileId,
        { [editingSession.section.key]: editingSession.revision },
      );
      if (!requestIsCurrent()) return;
      onSaved?.(manualReportValuesForUi(response.manual_values), requestIsCurrent);
      if (!requestIsCurrent()) return;
      await onReload();
      if (!requestIsCurrent()) return;
      sessionRef.current = null;
      setSession(null);
    } catch (error) {
      if (!requestIsCurrent()) return;
      const message = error instanceof Error
        ? error.message
        : "The report changes could not be saved.";
      const revisionConflict = /409|report_section_revision_conflict/i.test(message);
      let conflictReloaded = false;
      if (revisionConflict) {
        try { await onConflict?.(requestIsCurrent); conflictReloaded = Boolean(onConflict); } catch { /* Keep the failed reload explicit below. */ }
        if (!requestIsCurrent()) return;
        sessionRef.current = null;
        setSession(null);
      }
      if (/401|invalid_editor_key/i.test(message)) onCredentialRejected();
      if (!ownerIsCurrent() || readOnlyRef.current) return;
      window.alert(revisionConflict
        ? conflictReloaded
          ? "This report section changed after you opened it. The latest assignment revision was loaded; reopen the section and review before saving."
          : "This report section changed after you opened it. Reload the assignment before reopening this section and saving."
        : message);
    } finally {
      pendingSavesRef.current.delete(editingSession);
      if (mountedRef.current) setPendingSaves([...pendingSavesRef.current]);
    }
  }, [
    accountId,
    assignmentFileId,
    editingSession,
    getEditorKey,
    onConflict,
    onCredentialRejected,
    onReload,
    onSaved,
    owner,
    ownerIsCurrent,
  ]);

  return {
    editingSection: editingSession?.section || null,
    editingSessionKey: editingSession?.key || null,
    savingSection,
    editSection,
    cancelEditingSection,
    saveEditedSection,
  };
}
