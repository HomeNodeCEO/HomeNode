import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import { selectionFromRecordedGroups } from './customCohortPocketCatalog.ts';
import type { CustomCohortPreviewInput } from './customCohortPreviewController';
import type { CustomCohortSubdivisionFamily } from './customCohortSubdivisionFamilies';
import { buildCustomCohortSubdivisionPhases } from './customCohortSubdivisionFamilies.ts';

// This is an inspection batching budget, not a population or selection limit.
// Larger families use the existing complete, independently requested summaries.
export const CUSTOM_SUBDIVISION_INSPECTION_PHASE_LIMIT = 32;

/** Request a whole family and its exact phase populations in one existing
 * preview. Temporary phase IDs never enter the saved inclusion selection. No
 * private-supplement phase population exists, so those contexts stay unbatched. */
export function buildCustomCohortSubdivisionInspection(
  catalog: CheckedPocketCatalog, family: CustomCohortSubdivisionFamily,
): CustomCohortPreviewInput['selection'] | null {
  if (catalog.private_sales) return null;
  const phases = buildCustomCohortSubdivisionPhases(catalog, family);
  if (phases.length < 2 || phases.length > CUSTOM_SUBDIVISION_INSPECTION_PHASE_LIMIT) return null;
  // Catalog literals permit longer names than the preview request grammar.
  // Preserve the literal UI label and fall back instead of rewriting it.
  if (phases.some(p => [p.id, p.label].some(value => !value.length || value.length > 200
    || value.trim() !== value || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) return null;
  const seen = new Set<string>();
  const pockets = phases.map(phase => {
    const union = selectionFromRecordedGroups(catalog, phase.pocket_ids, 1);
    const account_ids = union.pockets[0]?.account_ids ?? [];
    for (const id of account_ids) {
      if (seen.has(id)) throw new TypeError('overlapping_subdivision_inspection');
      seen.add(id);
    }
    return Object.freeze({ id: phase.id, label: phase.label, account_ids });
  });
  if (seen.size !== family.member_count) throw new TypeError('incomplete_subdivision_inspection');
  const selection = Object.freeze({ revision: 1, pockets: Object.freeze(pockets) });
  // Match the existing request boundary, without increasing its limits or
  // silently omitting phases/accounts to make a batch fit.
  if (seen.size > 50_000 || new TextEncoder().encode(JSON.stringify(selection)).length > 3_900_000) return null;
  return selection;
}
