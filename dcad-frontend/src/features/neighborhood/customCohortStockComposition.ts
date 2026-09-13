import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import { STOCK_COMPOSITION_DEFINITION as LEGACY_DEFINITION, STOCK_COMPOSITION_PROFILE as LEGACY_PROFILE,
  COUNTY_STOCK_COMPOSITION_DEFINITION, COUNTY_STOCK_COMPOSITION_PROFILE } from './customCohortStockCompositionDefinition.ts';

type Context = CheckedPocketCatalog['binding']['context_ref'];
type NumericCounts = readonly [readonly number[], readonly number[]];
export type StockCompositionPopulation = readonly [number, readonly NumericCounts[], readonly [readonly number[], readonly number[]]];
type SubjectCell = readonly [string, number | null, string];
type Header = ({ readonly composition_version: 1; readonly profile: typeof LEGACY_PROFILE }
  | { readonly composition_version: 2; readonly profile: typeof COUNTY_STOCK_COMPOSITION_PROFILE }) & {
  readonly binding: { readonly context_ref: Context; readonly captured_at: string };
}
export type CheckedStockComposition = Header & ({ readonly status: 'unavailable'; readonly reason: string } | {
  readonly status: 'available'; readonly reason: null; readonly mapping_version: 4 | 5;
  readonly bin_cuts: readonly (readonly number[] | null)[];
  readonly subject: { readonly numeric: readonly SubjectCell[]; readonly housing: readonly [string, string | null, string];
    readonly recorded_group_id: string | null; readonly group_reason: string | null };
  readonly all: StockCompositionPopulation;
  readonly pockets: readonly (readonly [string, ...StockCompositionPopulation])[];
});
const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('Invalid captured stock composition'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const own = Reflect.ownKeys(value);
  ensure(own.length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  for (const key of own) { const d = Object.getOwnPropertyDescriptor(value, key)!; ensure(d.enumerable && Object.hasOwn(d, 'value')); }
  return value as Record<string, unknown>;
}
function array(value: unknown, length: number): unknown[] {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === length
    && Reflect.ownKeys(value).length === length + 1);
  for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); ensure(d?.enumerable && Object.hasOwn(d, 'value')); }
  return value;
}
function fixed(value: unknown, expected: unknown): void {
  if (Array.isArray(expected)) { array(value, expected.length).forEach((v, i) => fixed(v, expected[i])); return; }
  if (expected && typeof expected === 'object') {
    const e = expected as Record<string, unknown>, v = object(value, Object.keys(e));
    for (const key of Object.keys(e)) fixed(v[key], e[key]); return;
  }
  ensure(value === expected);
}
function count(value: unknown): number { ensure(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 50_000); return Number(value); }
const counts = (value: unknown, length: number) => array(value, length).map(count);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function population(value: unknown, cuts: readonly (readonly number[] | null)[]): StockCompositionPopulation {
  const p = array(value, 3), n = count(p[0]);
  const numeric = array(p[1], 3).map((raw, field): NumericCounts => {
    const parts = array(raw, 2), states = counts(parts[0], 5), bins = counts(parts[1], 4);
    ensure(sum(states) === n && sum(bins) === states[0] + states[1]);
    if (cuts[field] === null) ensure(sum(bins) === 0);
    else { if (cuts[field][0] === cuts[field][1]) ensure(bins[1] === 0); if (cuts[field][1] === cuts[field][2]) ensure(bins[2] === 0); }
    return [states, bins];
  });
  const housing = array(p[2], 2), states = counts(housing[0], 5), categories = counts(housing[1], 7);
  ensure(sum(states) === n && sum(categories) === states[0]);
  return [n, numeric, [states, categories]];
}
function merged(rows: readonly StockCompositionPopulation[]): StockCompositionPopulation {
  const n = rows.reduce((total, row) => total + row[0], 0); ensure(n <= 50_000);
  const columns = (length: number, values: (row: StockCompositionPopulation) => readonly number[]) =>
    Array.from({ length }, (_, i) => rows.reduce((total, row) => total + values(row)[i], 0));
  return [n, Array.from({ length: 3 }, (_, i): NumericCounts => [columns(5, r => r[1][i][0]), columns(4, r => r[1][i][1])]),
    [columns(5, r => r[2][0]), columns(7, r => r[2][1])]];
}

/** Admit the complete optional distribution envelope against the SAME catalog.
 * It has no selection/report authority and is never a replacement for exact
 * inspector statistics. Dynamic cuts cannot be compared across contexts. */
export function checkCustomCohortStockComposition(value: unknown, catalog: Pick<CheckedPocketCatalog,
  'binding' | 'pockets' | 'unassigned' | 'coverage' | 'subject_membership'>): CheckedStockComposition {
  ensure(value !== null && typeof value === 'object');
  const status = Object.getOwnPropertyDescriptor(value, 'status'); ensure(status && Object.hasOwn(status, 'value'));
  const available = status.value === 'available'; ensure(available || status.value === 'unavailable');
  const r = object(value, ['composition_version', 'profile', 'binding', 'status', 'reason',
    ...(available ? ['mapping_version', 'housing_profile', 'definition', 'bin_cuts', 'subject', 'all', 'pockets'] : [])]);
  ensure(r.composition_version === 1 || r.composition_version === 2);
  const D = r.composition_version === 1 ? LEGACY_DEFINITION : COUNTY_STOCK_COMPOSITION_DEFINITION;
  const profile = r.composition_version === 1 ? LEGACY_PROFILE : COUNTY_STOCK_COMPOSITION_PROFILE;
  fixed(r.profile, profile);
  const binding = object(r.binding, ['context_ref', 'captured_at']); fixed(binding.context_ref, catalog.binding.context_ref);
  ensure(typeof binding.captured_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(binding.captured_at)
    && Number.isFinite(Date.parse(binding.captured_at)) && new Date(binding.captured_at).toISOString() === binding.captured_at);
  const checkedBinding = { context_ref: { ...catalog.binding.context_ref }, captured_at: binding.captured_at };
  const header: Header = r.composition_version === 1
    ? { composition_version: 1, profile: LEGACY_PROFILE, binding: checkedBinding }
    : { composition_version: 2, profile: COUNTY_STOCK_COMPOSITION_PROFILE, binding: checkedBinding };
  if (!available) {
    ensure(typeof r.reason === 'string' && ['catalog_incomplete', 'account_limit', 'group_limit', 'housing_interpretation_unavailable', 'output_byte_limit'].includes(r.reason));
    return freeze({ ...header, status: 'unavailable', reason: r.reason });
  }
  ensure(r.reason === null && (r.mapping_version === 4 || r.mapping_version === 5));
  fixed(r.definition, D); fixed(r.housing_profile, D.housing_profiles[r.mapping_version === 4 ? 0 : 1]);
  const cuts = array(r.bin_cuts, 3).map(raw => {
    if (raw === null) return null;
    const values = array(raw, 3).map(v => { ensure(typeof v === 'number' && Number.isFinite(v)); return v; });
    ensure(values[0] <= values[1] && values[1] <= values[2]); return values;
  });
  const known = new Map(catalog.pockets.map(p => [p.id, p.member_count]));
  if (catalog.unassigned.member_count) known.set('discovery:unassigned', catalog.unassigned.member_count);
  ensure(known.size <= 1025);
  const seen = new Set<string>(); let previous = '';
  const pockets = array(r.pockets, known.size).map((raw): readonly [string, ...StockCompositionPopulation] => {
    const p = array(raw, 4), id = p[0]; ensure(typeof id === 'string' && known.has(id) && !seen.has(id) && id > previous);
    previous = id; seen.add(id); const stats = population(p.slice(1), cuts); ensure(stats[0] === known.get(id));
    return [id, ...stats];
  });
  const all = population(r.all, cuts); ensure(all[0] === catalog.coverage.discovery_member_count);
  fixed(all, merged(pockets.map(p => [p[1], p[2], p[3]])));
  for (let i = 0; i < 3; i++) ensure((cuts[i] === null) === (sum(all[1][i][1]) === 0));
  const s = object(r.subject, ['numeric', 'housing', 'recorded_group_id', 'group_reason']);
  ensure(s.recorded_group_id === catalog.subject_membership.assigned_pocket_id);
  ensure(s.recorded_group_id === null ? s.group_reason === catalog.subject_membership.status
    && ['not_in_discovery', 'unassigned', 'conflicting_evidence', 'invalid_evidence'].includes(String(s.group_reason)) : s.group_reason === null);
  const numeric = array(s.numeric, 3).map((raw): SubjectCell => {
    const c = array(raw, 3); ensure(typeof c[0] === 'string' && D.subject_numeric_states.some(v => v === c[0])
      && typeof c[2] === 'string' && D.subject_origins.some(v => v === c[2]));
    ensure(c[0] === 'observed' ? typeof c[1] === 'number' && Number.isFinite(c[1]) : c[1] === null);
    return [c[0], c[1] as number | null, c[2]];
  });
  const h = array(s.housing, 3); ensure(typeof h[0] === 'string' && D.housing_states.some(v => v === h[0])
    && (h[0] === 'observed' ? D.housing_categories.some(v => v === h[1]) : h[1] === null)
    && typeof h[2] === 'string' && D.subject_origins.some(v => v === h[2]));
  ensure(new TextEncoder().encode(JSON.stringify(value)).length <= 256_000);
  return freeze({ ...header, status: 'available', reason: null, mapping_version: r.mapping_version, bin_cuts: cuts,
    subject: { numeric, housing: [h[0], h[1] as string | null, h[2]], recorded_group_id: s.recorded_group_id as string | null,
      group_reason: s.group_reason as string | null }, all, pockets });
}

/** Exact unique original-leaf union; phase medians are never averaged. */
export function unionCustomCohortStockComposition(composition: Extract<CheckedStockComposition, { status: 'available' }>,
  ids: readonly string[]): StockCompositionPopulation {
  ensure(ids.length <= 1025 && new Set(ids).size === ids.length);
  const byId = new Map(composition.pockets.map(p => [p[0], p]));
  return freeze(merged(ids.map(id => { const p = byId.get(id); ensure(p); return [p[1], p[2], p[3]]; })));
}

export function stockCompositionOverlap(left: readonly number[], right: readonly number[]): number | null {
  ensure(left.length === right.length && left.length > 0 && left.length <= 7);
  left.forEach(count); right.forEach(count);
  const a = sum(left), b = sum(right); if (!a || !b) return null;
  return Math.max(0, Math.min(100, 100 * (1 - left.reduce((total, n, i) => total + Math.abs(n / a - right[i] / b), 0) / 2)));
}
