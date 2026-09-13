import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CheckedStockComposition, StockCompositionPopulation } from './customCohortStockComposition';
import { unionCustomCohortStockComposition, stockCompositionOverlap } from './customCohortStockComposition.ts';
import { STOCK_COMPOSITION_PROFILE } from './customCohortStockCompositionDefinition.ts';
import type { CustomCohortSubdivisionFamilies, CustomCohortSubdivisionFamily } from './customCohortSubdivisionFamilies';
import { createCustomCohortSubdivisionPhaseReader } from './customCohortSubdivisionFamilies.ts';

type Context = CheckedPocketCatalog['binding']['context_ref'];
export interface CompositionCoverage { readonly total: number; readonly observed: number; readonly partial: number; readonly unknown: number }
export interface CompositionField {
  readonly key: 'gla_sqft' | 'year_built' | 'site_area_sqft' | 'housing'; readonly label: string;
  readonly overlap_percent: number | null; readonly coverage: CompositionCoverage;
  readonly reference_coverage: CompositionCoverage | null;
}
interface ComparisonPopulation {
  readonly label: string; readonly pocket_ids: readonly string[]; readonly member_count: number; readonly fields: readonly CompositionField[];
}
export type StockCompositionComparison = { readonly status: 'unavailable'; readonly reason: string } | {
  readonly status: 'available'; readonly context_ref: Context; readonly profile: typeof STOCK_COMPOSITION_PROFILE;
  readonly grouping_profile_version: 1;
  readonly reference: { readonly status: 'available' | 'unavailable'; readonly reason: string | null;
    readonly label: string | null; readonly pocket_ids: readonly string[]; readonly member_count: number | null };
  readonly subject: readonly { readonly label: string; readonly state: string; readonly value: number | string | null;
    readonly unit: string | null; readonly origin: string }[];
  readonly inspected: ComparisonPopulation; readonly selected: ComparisonPopulation;
};
const fields = ['gla_sqft', 'year_built', 'site_area_sqft', 'housing'] as const;
const labels = ['GLA', 'Year built', 'Site area', 'Housing type'];
const sameContext = (a: Context, b: Context) => a.context_id === b.context_id
  && a.context_revision === b.context_revision && a.context_sha256 === b.context_sha256;
const sameIds = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(b);
  return a.length === b.length && new Set(a).size === a.length && set.size === b.length && a.every(id => set.has(id));
};
const sameFamily = (a: CustomCohortSubdivisionFamily, b: CustomCohortSubdivisionFamily) => a.id === b.id
  && a.label === b.label && a.county === b.county && a.basis === b.basis && a.member_count === b.member_count && sameIds(a.pocket_ids, b.pocket_ids);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
const unavailable = (reason: string): StockCompositionComparison => Object.freeze({ status: 'unavailable', reason });
function coverage(population: StockCompositionPopulation, field: number): CompositionCoverage {
  const states = field < 3 ? population[1][field][0] : population[2][0];
  const observed = states[0], partial = states[field < 3 ? 1 : 3];
  return { total: population[0], observed, partial, unknown: population[0] - observed - partial };
}
const bins = (population: StockCompositionPopulation, field: number) => field < 3 ? population[1][field][1] : population[2][1];

/** Request-free advisory over checked originals. Prepare once per exact catalog
 * and family model; changing the inspected phase only sums compact histograms.
 * No account scans, nearest-name search, global cache or selection mutation.
 * This does not replace the transport's original composition admission. */
export function createCustomCohortStockCompositionComparison({ catalog, families, contextRef, composition }: {
  catalog: CheckedPocketCatalog; families: CustomCohortSubdivisionFamilies; contextRef: Context;
  composition: CheckedStockComposition | null | undefined;
}): (input: { family: CustomCohortSubdivisionFamily; inspectedPocketIds: readonly string[]; selectedPocketIds: readonly string[] }) => StockCompositionComparison {
  if (!sameContext(catalog.binding.context_ref, contextRef) || !sameContext(families.context_ref, contextRef)
    || composition && !sameContext(composition.binding.context_ref, contextRef)) return () => unavailable('context_mismatch');
  if (families.profile_version !== 1) return () => unavailable('grouping_mismatch');
  if (catalog.status !== 'review_only') return () => unavailable('catalog_incomplete');
  if (!composition) return () => unavailable('composition_unavailable');
  if (composition.composition_version !== 1 || composition.profile.id !== STOCK_COMPOSITION_PROFILE.id
    || composition.profile.revision !== STOCK_COMPOSITION_PROFILE.revision
    || composition.profile.content_sha256 !== STOCK_COMPOSITION_PROFILE.content_sha256) return () => unavailable('profile_mismatch');
  if (composition.status !== 'available') return () => unavailable(composition.reason);
  const known = new Map(catalog.pockets.map(p => [p.id, p.member_count]));
  if (catalog.unassigned.member_count) known.set('discovery:unassigned', catalog.unassigned.member_count);
  if (composition.pockets.length !== known.size || new Set(composition.pockets.map(p => p[0])).size !== known.size
    || composition.pockets.some(p => known.get(p[0]) !== p[1])
    || composition.all[0] !== catalog.coverage.discovery_member_count
    || composition.subject.recorded_group_id !== catalog.subject_membership.assigned_pocket_id) return () => unavailable('original_membership_mismatch');
  const readPhases = createCustomCohortSubdivisionPhaseReader(catalog);
  const admittedFamily = (family: CustomCohortSubdivisionFamily) => {
    const matches = families.families.filter(item => item.id === family.id);
    if (matches.length !== 1 || !sameFamily(matches[0], family)
      || family.pocket_ids.some(id => families.family_id_by_pocket_id[id] !== family.id)) throw new TypeError('family_mismatch');
    return readPhases(family);
  };
  const subjectId = composition.subject.recorded_group_id;
  let referenceFamily: CustomCohortSubdivisionFamily | null = null, referencePopulation: StockCompositionPopulation | null = null;
  let referenceReason: string | null = subjectId === null ? 'subject_reference_unavailable' : null;
  if (subjectId !== null) {
    const matches = families.families.filter(family => family.pocket_ids.includes(subjectId));
    if (matches.length !== 1) referenceReason = 'subject_reference_ambiguous';
    else {
      try {
        admittedFamily(matches[0]);
        const population = unionCustomCohortStockComposition(composition, matches[0].pocket_ids);
        if (!population[0]) referenceReason = 'subject_reference_empty';
        else { referenceFamily = matches[0]; referencePopulation = population; }
      } catch { referenceReason = 'subject_reference_ambiguous'; }
    }
  }
  const subject = composition.subject.numeric.map((cell, index) => ({ label: labels[index], state: cell[0],
    value: cell[1], unit: index === 1 ? null : 'ft²', origin: cell[2] }));
  const housing = composition.subject.housing;
  const subjectCells = [...subject, { label: labels[3], state: housing[0], value: housing[1], unit: null, origin: housing[2] }];
  const describe = (label: string, ids: readonly string[]): ComparisonPopulation => {
    const population = unionCustomCohortStockComposition(composition, ids);
    return { label, pocket_ids: [...ids].sort(), member_count: population[0], fields: fields.map((key, index) => ({
      key, label: labels[index], coverage: coverage(population, index),
      reference_coverage: referencePopulation ? coverage(referencePopulation, index) : null,
      overlap_percent: referencePopulation ? stockCompositionOverlap(bins(population, index), bins(referencePopulation, index)) : null,
    })) };
  };
  return ({ family, inspectedPocketIds, selectedPocketIds }) => {
    try {
      const phases = admittedFamily(family);
      const phase = phases.find(item => sameIds(item.pocket_ids, inspectedPocketIds));
      const whole = sameIds(family.pocket_ids, inspectedPocketIds);
      if (!whole && !phase) return unavailable('inspection_union_mismatch');
      if (selectedPocketIds.length > known.size || new Set(selectedPocketIds).size !== selectedPocketIds.length
        || selectedPocketIds.some(id => !known.has(id))) return unavailable('selection_union_mismatch');
      return freeze({ status: 'available', context_ref: { ...contextRef }, profile: { ...STOCK_COMPOSITION_PROFILE }, grouping_profile_version: 1,
        reference: { status: referencePopulation ? 'available' : 'unavailable', reason: referenceReason,
          label: referenceFamily?.label ?? null, pocket_ids: [...(referenceFamily?.pocket_ids ?? [])].sort(), member_count: referencePopulation?.[0] ?? null },
        subject: subjectCells.map(cell => ({ ...cell })), inspected: describe(whole ? family.label : phase!.label, inspectedPocketIds),
        selected: describe('Current selected union', selectedPocketIds) });
    } catch { return unavailable('family_mismatch'); }
  };
}
