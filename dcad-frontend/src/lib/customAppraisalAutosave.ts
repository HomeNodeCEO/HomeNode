export const CUSTOM_APPRAISAL_AUTOSAVE_IDLE_MS = 10_000;
export const CUSTOM_APPRAISAL_AUTOSAVE_MAX_WAIT_MS = 55_000;

export type CustomAppraisalAutosaveState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

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
