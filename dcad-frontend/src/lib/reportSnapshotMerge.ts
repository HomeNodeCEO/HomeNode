const PROTOTYPE_CONTROL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([key]) => !PROTOTYPE_CONTROL_KEYS.has(key));
}

/**
 * Overlay a saved appraisal snapshot without allowing legacy blank fields to
 * erase newer authoritative CAD data. Explicit values (including false and 0)
 * still win, while blank strings, empty arrays, nulls, and empty objects fall
 * back to the current source value.
 */
export function mergeNonBlankSnapshot<T>(base: T, snapshot: unknown): T {
  if (!isPlainObject(snapshot)) {
    return hasSnapshotValue(snapshot) ? snapshot as T : base;
  }
  if (!hasSnapshotValue(snapshot)) return base;

  const merged: Record<string, unknown> = isPlainObject(base)
    ? Object.fromEntries(safeEntries(base))
    : {};
  for (const [key, snapshotValue] of safeEntries(snapshot)) {
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
  if (isPlainObject(value)) return safeEntries(value).some(([, entry]) => hasSnapshotValue(entry));
  if (typeof value === "object") return false;
  return true;
}
