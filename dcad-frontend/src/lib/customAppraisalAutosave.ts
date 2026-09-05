export const CUSTOM_APPRAISAL_AUTOSAVE_IDLE_MS = 10_000;
export const CUSTOM_APPRAISAL_AUTOSAVE_MAX_WAIT_MS = 55_000;

export type CustomAppraisalAutosaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

export function isVisibleManualAssignmentSave(
  saveReason: "manual_save" | "autosave",
): boolean {
  return saveReason === "manual_save";
}

export const CUSTOM_APPRAISAL_AUTOSAVE_MESSAGES = Object.freeze({
  conflict: "Another session changed the same report fields. Your edits are preserved; choose which values to keep.",
  rebased: "The file changed elsewhere. Your nonconflicting edits were preserved and rebased for autosave.",
  retry: "This file changed elsewhere and the latest revision could not be reconciled yet. Your edits remain on screen and autosave will retry.",
});

export function captureAssignmentSaveSelection(
  generationRef: { current: number },
  fileRef: { current: { id: number } | null },
  fileId: number,
): () => boolean {
  const generation = generationRef.current;
  return () => generation === generationRef.current && fileRef.current?.id === fileId;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Preserve local edits while accepting unrelated changes saved by another
 * browser or device. Only fields changed both locally and remotely are
 * returned for an explicit appraiser decision.
 */
export function reconcileCustomAppraisalDraft<T extends object>(
  base: T,
  local: T,
  remote: T,
): {
  rebased: T;
  conflictKeys: string[];
  localChangedKeys: string[];
} {
  const baseRecord = base as Record<string, unknown>;
  const localRecord = local as Record<string, unknown>;
  const remoteRecord = remote as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(localRecord),
    ...Object.keys(remoteRecord),
  ]);
  const rebased: Record<string, unknown> = { ...remoteRecord };
  const conflictKeys: string[] = [];
  const localChangedKeys: string[] = [];

  for (const key of keys) {
    const localChanged = !jsonEqual(localRecord[key], baseRecord[key]);
    if (!localChanged) continue;
    localChangedKeys.push(key);
    const remoteChanged = !jsonEqual(remoteRecord[key], baseRecord[key]);
    if (remoteChanged && !jsonEqual(localRecord[key], remoteRecord[key])) {
      conflictKeys.push(key);
    }
    rebased[key] = localRecord[key];
  }

  return {
    rebased: rebased as T,
    conflictKeys,
    localChangedKeys,
  };
}

export function customAppraisalDraftsMatch(left: object, right: object): boolean {
  return jsonEqual(left, right);
}

export function retainCurrentDraftWhenUnchanged<T extends object>(
  current: T,
  updated: T,
): T {
  return customAppraisalDraftsMatch(current, updated) ? current : updated;
}
