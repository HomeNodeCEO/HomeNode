function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Overlay a saved appraisal snapshot without allowing legacy blank fields to
 * erase newer authoritative CAD data. Explicit values (including false and 0)
 * still win, while blank strings, empty arrays, nulls, and empty objects fall
 * back to the current source value.
 */
export function mergeNonBlankSnapshot<T>(base: T, snapshot: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(snapshot)) {
    return hasSnapshotValue(snapshot) ? snapshot as T : base;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, snapshotValue] of Object.entries(snapshot)) {
    const baseValue = merged[key];
    if (isPlainObject(snapshotValue)) {
      if (Object.keys(snapshotValue).length > 0) {
        merged[key] = mergeNonBlankSnapshot(
          isPlainObject(baseValue) ? baseValue : {},
          snapshotValue,
        );
      }
      continue;
    }
    if (hasSnapshotValue(snapshotValue)) merged[key] = snapshotValue;
  }
  return merged as T;
}

export function hasSnapshotValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasSnapshotValue);
  return true;
}
