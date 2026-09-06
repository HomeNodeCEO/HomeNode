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
  documentConflict: "Contract evidence was saved; your existing edits were preserved for conflict review.",
  documentSaved: "Approved contract evidence and analysis were saved to this appraisal file.",
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

function isNeighborhoodSelectionField(key: string): boolean {
  // City/market/land-use analyses have independent inputs and remain separate.
  // Value narratives travel with their median and automatic-source companions.
  return /^neighborhood_(boundary_|relevance_|value_)/u.test(key) ||
    /^neighborhood_(?:all_)?(?:house_price|ppsf|age|gla)_(?:low|high|predominant)$/u.test(key) ||
    /^neighborhood_all_(?:value|ppsf|age|gla)_count$/u.test(key) ||
    key === "neighborhood_sale_count" || key === "neighborhood_all_property_count";
}

function copyFields(target: Record<string, unknown>, source: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
    else delete target[key];
  }
}

export function applyCustomAppraisalRemoteConflicts<T extends object>(current: T, remote: T, keys: string[]): T {
  const next = { ...current } as Record<string, unknown>;
  copyFields(next, remote as Record<string, unknown>, keys);
  return next as T;
}

/**
 * Preserve local edits while accepting unrelated changes saved by another
 * browser or device. Neighborhood selection and its statistics are indivisible:
 * two-sided group changes require one decision even when different keys changed.
 */
export function reconcileCustomAppraisalDraft<T extends object>(
  base: T,
  local: T,
  remote: T,
  unresolvedConflictKeys: readonly string[] = [],
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
    ...unresolvedConflictKeys,
  ]);
  const rebased: Record<string, unknown> = { ...remoteRecord };
  const conflictKeys = new Set(unresolvedConflictKeys.filter(key => !isNeighborhoodSelectionField(key)));
  const localChangedKeys: string[] = [];
  const neighborhoodKeys = [...keys].filter(isNeighborhoodSelectionField);
  const unresolvedNeighborhood = unresolvedConflictKeys.some(isNeighborhoodSelectionField);
  const localNeighborhoodChanged = neighborhoodKeys.some(key => !jsonEqual(localRecord[key], baseRecord[key]));
  const neighborhoodConflict = unresolvedNeighborhood || (localNeighborhoodChanged &&
    neighborhoodKeys.some(key => !jsonEqual(remoteRecord[key], baseRecord[key])) &&
    neighborhoodKeys.some(key => !jsonEqual(localRecord[key], remoteRecord[key])));

  for (const key of keys) {
    const localChanged = !jsonEqual(localRecord[key], baseRecord[key]);
    if (!localChanged) continue;
    localChangedKeys.push(key);
    const remoteChanged = !jsonEqual(remoteRecord[key], baseRecord[key]);
    if (!isNeighborhoodSelectionField(key) && remoteChanged && !jsonEqual(localRecord[key], remoteRecord[key])) {
      conflictKeys.add(key);
    }
    rebased[key] = localRecord[key];
  }

  // An unrelated document can advance the saved baseline, but it cannot resolve
  // a choice already presented to the appraiser. Only an explicit choice can.
  copyFields(rebased, localRecord, [...unresolvedConflictKeys]);
  if (localNeighborhoodChanged || unresolvedNeighborhood) copyFields(rebased, localRecord, neighborhoodKeys);
  // Keep Remote consumes these keys, so include the entire group, not just edits.
  if (neighborhoodConflict) for (const key of neighborhoodKeys) conflictKeys.add(key);

  return {
    rebased: rebased as T,
    conflictKeys: [...conflictKeys],
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
