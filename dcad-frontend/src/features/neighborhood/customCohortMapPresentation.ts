import { CUSTOM_COHORT_UNASSIGNED_GROUP } from './customCohortPocketCatalog.ts';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortPreviewGroup } from './customCohortPreviewController';

export interface CustomCohortMapScore {
  readonly status: 'available' | 'unknown';
  readonly reason: null | 'recommendation_unavailable' | 'recommendation_insufficient' | 'group_observations_unavailable' | 'unassigned_recorded_group' | 'empty_group';
  readonly lower: number | null; readonly upper: number | null; readonly known_weight_percent: number | null;
}
export interface CustomCohortMapLabel {
  readonly type: 'Feature'; readonly id: string;
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
  readonly properties: {
    readonly pocket_id: string; readonly label: string; readonly county: string; readonly account_id: string; readonly parcel_id: string;
    readonly anchor_basis: 'retained_exterior_ring_vertex';
  };
}
export interface CustomCohortMapPresentation {
  readonly status: 'available' | 'unavailable';
  readonly reason: null | 'context_mismatch' | 'parcel_geometry_unavailable' | 'catalog_geometry_mismatch';
  readonly scoresByGroup: Readonly<Record<string, CustomCohortMapScore>>;
  readonly labels: { readonly type: 'FeatureCollection'; readonly features: readonly CustomCohortMapLabel[] };
  readonly unlabelled_group_ids: readonly string[];
}
export const CUSTOM_COHORT_MAP_PRESENTATION_LIMITS = Object.freeze({ groups: 128, accounts: 50000, parcels: 100000,
  coordinates: 250000, outputBytes: 512000 });
const L = CUSTOM_COHORT_MAP_PRESENTATION_LIMITS, encoder = new TextEncoder();
const check: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('invalid_custom_cohort_map_presentation'); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Row = Record<string, unknown>;
function object(value: unknown): Row {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype); return value as Row;
}
function field(value: unknown, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object(value), key); check(d?.enumerable && Object.hasOwn(d, 'value')); return d.value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); check(d?.enumerable && Object.hasOwn(d, 'value')); }
  return value;
}
function text(value: unknown, maximum: number): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum && encoder.encode(value).length <= maximum
    && Array.from(value).every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)); return value;
}
function count(value: unknown, maximum: number = L.accounts): number {
  check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum); return Number(value);
}
function context(value: unknown): string {
  check(field(value, 'context_revision') === '1');
  return JSON.stringify([text(field(value, 'context_id'), 200), '1', text(field(value, 'context_sha256'), 64)]);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function result(status: CustomCohortMapPresentation['status'], reason: CustomCohortMapPresentation['reason'],
  scoresByGroup: Record<string, CustomCohortMapScore>, features: CustomCohortMapLabel[], unlabelled: readonly string[]): CustomCohortMapPresentation {
  const output = { status, reason, scoresByGroup, labels: { type: 'FeatureCollection' as const, features }, unlabelled_group_ids: [...unlabelled] };
  check(encoder.encode(JSON.stringify(output)).length <= L.outputBytes); return freeze(output);
}
function scores(catalog: CheckedPocketCatalog, groups: ReadonlyMap<string, { count: number }>): Record<string, CustomCohortMapScore> {
  const result: Record<string, CustomCohortMapScore> = {}, byId = new Map<string, { lower: number | null; upper: number | null; known_weight_percent: number | null }>();
  const descriptor = Object.getOwnPropertyDescriptor(catalog, 'recommendation');
  check(!descriptor || (descriptor.enumerable && Object.hasOwn(descriptor, 'value')));
  const recommendation = descriptor?.value;
  if (recommendation !== null && recommendation !== undefined) {
    const status = field(recommendation, 'status'); check(status === 'recommendation_for_review' || status === 'insufficient_observations');
    for (const p of array(field(recommendation, 'pockets'), L.groups + 1)) {
      const id = text(field(p, 'id'), 200), group = groups.get(id); check(group && !byId.has(id) && count(field(p, 'member_count')) === group.count);
      const similarity = field(p, 'similarity');
      const values = ['lower', 'upper', 'known_weight_percent'].map(key => {
        const value = field(similarity, key);
        check(group.count ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 : value === null);
        return value as number | null;
      });
      const [lower, upper, known_weight_percent] = values;
      if (group.count) check(lower! <= upper! && lower! <= known_weight_percent! + .0002
        && Math.abs(upper! - lower! - 100 + known_weight_percent!) <= .0003);
      byId.set(id, { lower, upper, known_weight_percent });
    }
    check(byId.size === groups.size);
  }
  for (const [id, group] of groups) {
    const values = byId.get(id) ?? { lower: null, upper: null, known_weight_percent: null };
    const reason = id === CUSTOM_COHORT_UNASSIGNED_GROUP ? 'unassigned_recorded_group' : !recommendation ? 'recommendation_unavailable'
      : field(recommendation, 'status') === 'insufficient_observations' ? 'recommendation_insufficient' : !group.count ? 'empty_group'
        : values.known_weight_percent === 0 ? 'group_observations_unavailable' : null;
    Object.defineProperty(result, id, { enumerable: true, value: { status: reason === null ? 'available' : 'unknown', reason, ...values } });
  }
  return result;
}
type Candidate = { account: string; parcel: string; point: readonly [number, number] };
function coordinateBefore(a: readonly number[], b: readonly number[]): boolean { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }

/** Presentation of already checked catalog/controller results, not a second
 * source admission API. Scores remain the existing all-discovery group means;
 * they are not individual-parcel scores or reliability. Selection revision may
 * differ from the static catalog revision. Only exact retained account identity
 * joins geometry. A label marks one actual exterior vertex, never a new boundary,
 * a centroid inside an untested polygon, or a claim of legal subdivision extent. */
export function buildCustomCohortMapPresentation({ catalog, group }: {
  readonly catalog: CheckedPocketCatalog; readonly group: CustomCohortPreviewGroup;
}): CustomCohortMapPresentation {
  const pockets = array(field(catalog, 'pockets'), L.groups), pocketIds: string[] = [];
  const groupBinding = field(group, 'binding'), catalogBinding = field(catalog, 'binding');
  const subject = text(field(field(catalog, 'subject_membership'), 'account_id'), 100);
  if (context(field(groupBinding, 'contextRef')) !== context(field(catalogBinding, 'context_ref'))
    || text(field(groupBinding, 'accountId'), 100) !== subject) return result('unavailable', 'context_mismatch', {}, [], []);
  const accounts = new Map<string, string>(), known = new Map<string, { count: number }>();
  const named = new Map<string, { label: string; county: string }>();
  function members(id: string, value: unknown, memberCount: unknown) {
    const ids = array(value, L.accounts); check(ids.length === count(memberCount));
    for (const raw of ids) {
      const account = text(raw, 100); check(account.trim() === account && !accounts.has(account) && accounts.size < L.accounts); accounts.set(account, id);
    }
    known.set(id, { count: ids.length });
  }
  for (const p of pockets) {
    const id = text(field(p, 'id'), 200); check(id.startsWith('recorded-cad:') && !named.has(id));
    named.set(id, { label: text(field(p, 'label'), 512), county: text(field(p, 'county'), 512) }); pocketIds.push(id);
    members(id, field(p, 'account_ids'), field(p, 'member_count'));
  }
  pocketIds.sort(compare);
  const unassigned = field(catalog, 'unassigned'), unassignedAccounts = field(unassigned, 'account_ids');
  if (array(unassignedAccounts, L.accounts).length) members(CUSTOM_COHORT_UNASSIGNED_GROUP, unassignedAccounts, field(unassigned, 'member_count'));
  else check(count(field(unassigned, 'member_count')) === 0);
  const coverage = field(catalog, 'coverage'); check(count(field(coverage, 'discovery_member_count')) === accounts.size
    && count(field(coverage, 'unassigned_account_count')) === count(field(unassigned, 'member_count'))
    && count(field(coverage, 'assigned_account_count')) === accounts.size - count(field(unassigned, 'member_count')));
  const scoreMap = scores(catalog, known), map = field(group, 'parcel_map');
  if (field(map, 'status') === 'unavailable') return result('unavailable', 'parcel_geometry_unavailable', scoreMap, [], pocketIds);
  check(field(map, 'status') === 'available');
  const geojson = field(map, 'geojson'); check(field(geojson, 'type') === 'FeatureCollection');
  const features = array(field(geojson, 'features'), L.parcels), candidates = new Map<string, Candidate>();
  const represented = new Set<string>(), parcelIds = new Set<string>(); let coordinates = 0;
  function polygon(raw: unknown): readonly [number, number] {
    const rings = array(raw, Math.floor(L.coordinates / 4)); check(rings.length > 0); let anchor: readonly [number, number] | null = null;
    for (const [index, r] of rings.entries()) {
      const ring = array(r, L.coordinates - coordinates); check(ring.length >= 4);
      let first: readonly [number, number] | null = null, last: readonly [number, number] | null = null;
      for (const raw of ring) {
        check(++coordinates <= L.coordinates); const point = array(raw, 2);
        check(point.length === 2 && typeof point[0] === 'number' && typeof point[1] === 'number'
          && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
        const pair: readonly [number, number] = [point[0], point[1]]; first ??= pair; last = pair;
        if (index === 0 && (anchor === null || coordinateBefore(pair, anchor))) anchor = pair;
      }
      check(first && last && first[0] === last[0] && first[1] === last[1]);
    }
    check(anchor); return anchor;
  }
  for (const f of features) {
    check(field(f, 'type') === 'Feature'); const props = field(f, 'properties'), parcel = text(field(f, 'id'), 100);
    check(!parcelIds.has(parcel) && parcel === `gis.dcad_parcels:${text(field(props, 'object_id'), 30)}`); parcelIds.add(parcel);
    const account = text(field(props, 'account_id'), 100), id = accounts.get(account);
    if (!id) return result('unavailable', 'catalog_geometry_mismatch', {}, [], pocketIds);
    represented.add(account); check(typeof field(props, 'selected') === 'boolean');
    const geometry = field(f, 'geometry'), kind = field(geometry, 'type'); let anchor: readonly [number, number];
    if (kind === 'Polygon') anchor = polygon(field(geometry, 'coordinates'));
    else {
      check(kind === 'MultiPolygon'); const parts = array(field(geometry, 'coordinates'), Math.floor(L.coordinates / 4)); check(parts.length > 0);
      let selected: readonly [number, number] | null = null;
      for (const part of parts) { const next = polygon(part); if (selected === null || coordinateBefore(next, selected)) selected = next; }
      check(selected); anchor = selected;
    }
    if (!named.has(id)) continue;
    const previous = candidates.get(id);
    if (!previous || compare(account, previous.account) < 0 || (account === previous.account && compare(parcel, previous.parcel) < 0))
      candidates.set(id, { account, parcel, point: anchor });
  }
  if (represented.size !== accounts.size) return result('unavailable', 'catalog_geometry_mismatch', {}, [], pocketIds);
  const labels: CustomCohortMapLabel[] = [], unlabelled: string[] = [];
  for (const id of pocketIds) {
    const c = candidates.get(id); if (!c) { unlabelled.push(id); continue; }
    const name = named.get(id)!;
    labels.push({ type: 'Feature', id: `custom-cohort-label:${id}`, geometry: { type: 'Point', coordinates: [c.point[0], c.point[1]] },
      properties: { pocket_id: id, label: name.label, county: name.county, account_id: c.account, parcel_id: c.parcel,
        anchor_basis: 'retained_exterior_ring_vertex' } });
  }
  return result('available', null, scoreMap, labels, unlabelled);
}
