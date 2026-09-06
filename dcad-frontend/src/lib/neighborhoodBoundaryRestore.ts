type BoundaryRestoreContext = {
  geometry?: unknown;
  source?: string | null;
  savedCustomGeometry?: unknown;
};

/** Automatic loading is not an instruction to replace an existing selection.
 * This is a UI adoption decision, not geometry validation or source authority.
 * The caller must supply the latest context after its asynchronous lookup.
 */
export function automaticBoundaryRestoreState(context: BoundaryRestoreContext) {
  const hasExistingGeometry = Boolean(context.geometry || context.savedCustomGeometry);
  const cleared = String(context.source || "").toLowerCase().includes("cleared");
  return { hasExistingGeometry, cleared, mayAdopt: !hasExistingGeometry && !cleared };
}
