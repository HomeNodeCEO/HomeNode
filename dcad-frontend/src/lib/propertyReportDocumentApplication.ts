import type { AppraisalAssignmentFile, AssignmentDocumentApplication } from './api';

/** Assignment-details saves do not own manual-section revisions. Reconcile at
 * setter execution time, including a manual save queued in the same React batch. */
export function preserveNewerReportSections(current: AppraisalAssignmentFile, saved: AppraisalAssignmentFile): AppraisalAssignmentFile {
  if (current.id !== saved.id || current.account_id !== saved.account_id) return current;
  const sections = { ...saved.custom_appraisal_sections };
  for (const [key, section] of Object.entries(current.custom_appraisal_sections || {})) {
    if (!sections[key] || section.revision >= sections[key].revision) sections[key] = section;
  }
  return { ...saved, custom_appraisal_sections: sections };
}

/** Apply only the exact selected file's server-saved state, never source receipts
 * or an older section/assignment revision. Local assignment drafts are reconciled
 * separately by the report's existing autosave path. */
export function mergeDocumentApplication(
  current: AppraisalAssignmentFile,
  application: AssignmentDocumentApplication,
): { file: AppraisalAssignmentFile; assignmentUpdated: boolean; sectionsUpdated: boolean } | null {
  if (application.account_id !== current.account_id || application.assignment_file_id !== current.id) return null;
  if (current.workfile?.status === 'signed' || current.workfile?.status === 'archived') return null;
  const assignmentUpdated = Boolean(application.assignment_details && Number.isSafeInteger(application.revision)
    && Number(application.revision) > current.revision);
  const incoming = application.custom_appraisal_sections?.['report.subject_identification'];
  const existing = current.custom_appraisal_sections?.['report.subject_identification'];
  const sectionsUpdated = Boolean(incoming && incoming.value && typeof incoming.value === 'object'
    && !Array.isArray(incoming.value) && Number.isSafeInteger(incoming.revision)
    && incoming.revision > (existing?.revision || 0));
  if (!assignmentUpdated && !sectionsUpdated) return null;
  return { assignmentUpdated, sectionsUpdated, file: {
    ...current,
    ...(assignmentUpdated ? { assignment_details: application.assignment_details!, revision: application.revision! } : {}),
    ...(sectionsUpdated ? { custom_appraisal_sections: {
      ...current.custom_appraisal_sections, 'report.subject_identification': incoming!,
    } } : {}),
  } };
}

export function documentApplicationWarnings(application?: AssignmentDocumentApplication): string {
  const warnings = (Array.isArray(application?.warnings) ? application.warnings : []).filter(item => typeof item === 'string' && item.trim());
  return warnings.length ? ` Review: ${warnings.slice(0, 3).map(item => item.trim().slice(0, 300)).join(' ')}${warnings.length > 3 ? ' Additional fields need review.' : ''}` : '';
}

export function documentApplicationMessage(summary: string, application?: AssignmentDocumentApplication): string {
  return `${summary} ${application?.applied
    ? 'Supported report fields were saved to this appraisal file.'
    : 'Approval retains source evidence; report fields may be unchanged.'}${documentApplicationWarnings(application)}`;
}
