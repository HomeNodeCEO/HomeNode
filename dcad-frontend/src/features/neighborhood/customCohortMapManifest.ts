import type { CustomCohortContextRef } from './customCohortPreviewController';
import type { CustomCohortMapLabel } from './customCohortMapPresentation';

export interface CheckedCustomCohortMapManifest {
  readonly status: 'available';
  readonly context_ref: CustomCohortContextRef;
  readonly geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary';
  readonly bounds: readonly [readonly [number, number], readonly [number, number]];
  readonly labels: { readonly type: 'FeatureCollection'; readonly features: readonly CustomCohortMapLabel[] };
  readonly unlabelled_group_ids: readonly string[];
  readonly subject_parcels: readonly { readonly parcel_id: string; readonly account_id: string;
    readonly coordinates: readonly [number, number]; readonly anchor_basis: 'retained_exterior_ring_vertex' }[];
  readonly counts: { readonly captured_parcels: number; readonly captured_accounts: number };
}
export type CustomCohortMapManifest = CheckedCustomCohortMapManifest | {
  readonly status: 'unavailable'; readonly context_ref: CustomCohortContextRef;
  readonly geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary'; readonly reason: string;
};

const SEMANTICS = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new TypeError('invalid_custom_cohort_map_manifest'); };
const assert: (ok: unknown) => asserts ok = ok => { if (!ok) fail(); };
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype); return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  assert(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
function point(value: unknown): readonly [number, number] {
  assert(Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90);
  return [value[0], value[1]];
}
function string(value: unknown, max: number): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value);
  for (let i = 0; i < value.length; i++) assert(value.charCodeAt(i) >= 32 && value.charCodeAt(i) !== 127);
  return value;
}
function context(value: unknown, expected: CustomCohortContextRef): CustomCohortContextRef {
  const ref = record(value); keys(ref, ['context_id', 'context_revision', 'context_sha256']);
  assert(UUID.test(string(ref.context_id, 36)) && ref.context_revision === '1' && HASH.test(string(ref.context_sha256, 64))
    && ref.context_id === expected.context_id && ref.context_revision === expected.context_revision
    && ref.context_sha256 === expected.context_sha256);
  return { context_id: ref.context_id as string, context_revision: '1', context_sha256: ref.context_sha256 as string };
}
/** This is display metadata, not a parcel boundary or a statistical population.
 * The checked catalog still decides every membership and score. */
export function checkCustomCohortMapManifest(value: unknown, expected: CustomCohortContextRef,
  subjectAccount: string): CustomCohortMapManifest {
  const m = record(value); assert(m.geometry_semantics === SEMANTICS);
  const ref = context(m.context_ref, expected);
  if (m.status === 'unavailable') {
    keys(m, ['status', 'context_ref', 'geometry_semantics', 'reason']);
    return Object.freeze({ status: 'unavailable', context_ref: ref, geometry_semantics: SEMANTICS,
      reason: string(m.reason, 200) });
  }
  keys(m, ['status', 'context_ref', 'geometry_semantics', 'bounds', 'labels', 'unlabelled_group_ids', 'subject_parcels', 'counts']);
  assert(m.status === 'available');
  assert(Array.isArray(m.bounds) && m.bounds.length === 2);
  const southwest = point(m.bounds[0]), northeast = point(m.bounds[1]);
  assert(southwest[0] <= northeast[0] && southwest[1] <= northeast[1]);
  const counts = record(m.counts); keys(counts, ['captured_parcels', 'captured_accounts']);
  assert(Number.isSafeInteger(counts.captured_parcels) && Number(counts.captured_parcels) > 0
    && Number(counts.captured_parcels) <= 100_000 && Number.isSafeInteger(counts.captured_accounts)
    && Number(counts.captured_accounts) > 0 && Number(counts.captured_accounts) <= 50_000);
  const labels = record(m.labels); keys(labels, ['type', 'features']);
  assert(labels.type === 'FeatureCollection' && Array.isArray(labels.features) && labels.features.length <= 2048);
  const ids = new Set<string>();
  const checkedLabels = labels.features.map(raw => {
    const item = record(raw); keys(item, ['type', 'id', 'geometry', 'properties']);
    const props = record(item.properties); keys(props, ['pocket_id', 'label', 'county', 'account_id', 'parcel_id', 'anchor_basis']);
    const id = string(props.pocket_id, 200);
    assert(item.type === 'Feature' && item.id === `custom-cohort-label:${id}` && !ids.has(id)
      && props.anchor_basis === 'retained_exterior_ring_vertex'); ids.add(id);
    const geometry = record(item.geometry); keys(geometry, ['type', 'coordinates']);
    const coordinates = point(geometry.coordinates); assert(geometry.type === 'Point'
      && coordinates[0] >= southwest[0] && coordinates[0] <= northeast[0]
      && coordinates[1] >= southwest[1] && coordinates[1] <= northeast[1]);
    return { type: 'Feature' as const, id: item.id as string, geometry: { type: 'Point' as const, coordinates },
      properties: { pocket_id: id, label: string(props.label, 512), county: string(props.county, 512),
        account_id: string(props.account_id, 100), parcel_id: string(props.parcel_id, 100),
        anchor_basis: 'retained_exterior_ring_vertex' as const } };
  });
  assert(Array.isArray(m.unlabelled_group_ids) && m.unlabelled_group_ids.length <= 2048);
  const unlabelled = m.unlabelled_group_ids.map(id => string(id, 200));
  assert(new Set(unlabelled).size === unlabelled.length && unlabelled.every(id => !ids.has(id)));
  assert(Array.isArray(m.subject_parcels) && m.subject_parcels.length <= 100_000);
  const subjectParcels = m.subject_parcels.map(raw => {
    const item = record(raw); keys(item, ['parcel_id', 'account_id', 'coordinates', 'anchor_basis']);
    assert(item.account_id === subjectAccount && item.anchor_basis === 'retained_exterior_ring_vertex');
    const coordinates = point(item.coordinates);
    assert(coordinates[0] >= southwest[0] && coordinates[0] <= northeast[0]
      && coordinates[1] >= southwest[1] && coordinates[1] <= northeast[1]);
    return { parcel_id: string(item.parcel_id, 100), account_id: subjectAccount, coordinates,
      anchor_basis: 'retained_exterior_ring_vertex' as const };
  });
  assert(new Set(subjectParcels.map(item => item.parcel_id)).size === subjectParcels.length);
  return Object.freeze({ status: 'available', context_ref: ref, geometry_semantics: SEMANTICS,
    bounds: [southwest, northeast] as const, labels: { type: 'FeatureCollection' as const, features: checkedLabels },
    unlabelled_group_ids: unlabelled, subject_parcels: subjectParcels,
    counts: { captured_parcels: Number(counts.captured_parcels), captured_accounts: Number(counts.captured_accounts) } });
}
