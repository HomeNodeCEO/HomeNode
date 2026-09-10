import type { CheckedPocketCatalog } from './customCohortPocketCatalog';

export const CUSTOM_CAD_FIELD_LABELS = {
  class_code: 'Recorded CAD class code', class_description: 'Recorded CAD class description',
  use_description: 'Recorded CAD use description', structure_type: 'Recorded CAD structure description',
  built_up: 'Local CAD built-up indicator; not house completion',
} as const;
type Field = keyof typeof CUSTOM_CAD_FIELD_LABELS;
type State = 'observed' | 'partial' | 'missing' | 'conflicting';
type Literal = string | boolean | null;
interface FieldSummary {
  readonly label: string;
  readonly observed_count: number; readonly partial_count: number; readonly missing_count: number; readonly conflicting_count: number;
  readonly record_count: number; readonly observed_record_count: number; readonly missing_record_count: number;
  readonly distribution: { readonly basis: 'accounts_with_literal_any_parcel_row_nonexclusive';
    readonly status: 'complete' | 'details_unavailable'; readonly reason: string | null; readonly distinct_literal_count: number;
    readonly entries: readonly { readonly literal: Literal; readonly account_count: number }[] | null };
  readonly subject_comparison: { readonly same_literal_count: number; readonly different_literal_count: number; readonly unavailable_count: number };
}
interface Summary { readonly member_count: number; readonly fields: Readonly<Record<Field, FieldSummary>> }
interface CadBinding {
  readonly cad_baseline_version: 1; readonly mapping_version: 4;
  readonly binding: { readonly context_ref: CheckedPocketCatalog['binding']['context_ref']; readonly captured_at: string };
}
interface AvailableCadEvidence extends CadBinding {
  readonly status: 'available'; readonly reason: null;
  readonly subject: { readonly in_discovery: boolean; readonly county_state: State;
    readonly fields: Readonly<Record<Field, { readonly state: State; readonly literal: Literal }>> };
  readonly all: Summary; readonly pockets: readonly (Summary & { readonly id: string })[];
}
export type CheckedCadRecordedEvidence = AvailableCadEvidence | (CadBinding & {
  readonly status: 'details_unavailable'; readonly reason: 'presentation_byte_limit';
  readonly member_count: number; readonly pocket_count: number;
});
type Catalog = Pick<CheckedPocketCatalog, 'binding' | 'pockets' | 'unassigned' | 'coverage' | 'subject_membership'>;
const FIELDS = Object.keys(CUSTOM_CAD_FIELD_LABELS) as Field[];
const STATES: readonly State[] = ['observed', 'partial', 'missing', 'conflicting'];
const OMIT_REASONS = ['distinct_literal_limit', 'distribution_byte_limit', 'baseline_output_byte_limit', 'presentation_byte_limit'];
const LIMITATIONS = ['recorded_literals_not_a_housing_type_dictionary', 'one_unit_does_not_establish_detached_housing',
  'built_up_is_a_local_indicator_not_completed_home_evidence', 'literal_match_not_housing_similarity_or_eligibility',
  'source_clock_not_historical_validity', 'all_accounts_retained_in_denominators',
  'distributions_count_accounts_per_literal_and_can_overlap', 'no_score_rank_selection_or_report_fact_changes'];
const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('Invalid recorded CAD evidence'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  ensure(Reflect.ownKeys(value).length === keys.length);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    ensure(d?.enumerable && Object.hasOwn(d, 'value'));
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i)); ensure(d?.enumerable && Object.hasOwn(d, 'value'));
  }
  return value;
}
function count(value: unknown, maximum = 100_000): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum); return value;
}
function text(value: unknown, maximum: number, blank = false): string {
  ensure(typeof value === 'string' && value.length <= maximum && (blank || value.trim().length > 0));
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i); ensure(code !== 0);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); ensure(next >= 0xdc00 && next <= 0xdfff); }
    else ensure(code < 0xdc00 || code > 0xdfff);
  }
  ensure(new TextEncoder().encode(value).length <= maximum); return value;
}
function state(value: unknown): State { ensure(STATES.includes(value as State)); return value as State; }
function literal(value: unknown, field: Field): Literal {
  if (value === null) return null;
  if (field === 'built_up') { ensure(typeof value === 'boolean'); return value; }
  return text(value, 4096, true);
}
const present = (value: Literal) => typeof value === 'boolean' || typeof value === 'string' && value.trim().length > 0;
function summary(value: Record<string, unknown>, expectedCount: number, subject: AvailableCadEvidence['subject']): Summary {
  const member_count = count(value.member_count, 50_000); ensure(member_count === expectedCount);
  const raw = object(value.fields, FIELDS);
  const fields = Object.fromEntries(FIELDS.map(field => {
    const v = object(raw[field], ['label', 'observed_count', 'partial_count', 'missing_count', 'conflicting_count',
      'record_count', 'observed_record_count', 'missing_record_count', 'distribution', 'subject_comparison']);
    const label = text(v.label, 128), observed_count = count(v.observed_count, member_count), partial_count = count(v.partial_count, member_count);
    ensure(label === CUSTOM_CAD_FIELD_LABELS[field]);
    const missing_count = count(v.missing_count, member_count), conflicting_count = count(v.conflicting_count, member_count);
    ensure(observed_count + partial_count + missing_count + conflicting_count === member_count);
    const record_count = count(v.record_count), observed_record_count = count(v.observed_record_count), missing_record_count = count(v.missing_record_count);
    ensure(observed_record_count + missing_record_count === record_count
      && observed_record_count >= observed_count + partial_count + 2 * conflicting_count && missing_record_count >= partial_count);
    const c = object(v.subject_comparison, ['same_literal_count', 'different_literal_count', 'unavailable_count']);
    const comparison = { same_literal_count: count(c.same_literal_count, member_count), different_literal_count: count(c.different_literal_count, member_count),
      unavailable_count: count(c.unavailable_count, member_count) };
    ensure(comparison.same_literal_count + comparison.different_literal_count + comparison.unavailable_count === member_count);
    ensure(comparison.same_literal_count + comparison.different_literal_count <= observed_count);
    if (!subject.in_discovery || subject.county_state !== 'observed' || subject.fields[field].state !== 'observed') {
      ensure(comparison.unavailable_count === member_count);
    }
    const d = object(v.distribution, ['basis', 'status', 'reason', 'distinct_literal_count', 'entries']);
    ensure(d.basis === 'accounts_with_literal_any_parcel_row_nonexclusive');
    const distinct_literal_count = count(d.distinct_literal_count); ensure(distinct_literal_count <= record_count);
    let entries: FieldSummary['distribution']['entries'] = null, reason: string | null = null;
    ensure(d.status === 'complete' || d.status === 'details_unavailable');
    if (d.status === 'complete') {
      ensure(d.reason === null);
      const seen = new Set<string>(); entries = array(d.entries, 64).map(item => {
        const entry = object(item, ['literal', 'account_count']), value = literal(entry.literal, field), key = JSON.stringify(value);
        ensure(!seen.has(key)); seen.add(key);
        const account_count = count(entry.account_count, member_count); ensure(account_count > 0);
        ensure(account_count <= (present(value) ? observed_count + partial_count + conflicting_count : missing_count + partial_count + conflicting_count));
        return { literal: value, account_count };
      });
      ensure(entries.length === distinct_literal_count && entries.reduce((sum, entry) => sum + entry.account_count, 0) <= record_count);
      ensure((record_count === 0) === (entries.length === 0));
      const knownTotal = entries.filter(entry => present(entry.literal)).reduce((sum, entry) => sum + entry.account_count, 0);
      const missingTotal = entries.filter(entry => !present(entry.literal)).reduce((sum, entry) => sum + entry.account_count, 0);
      const sameTotal = entries.find(entry => present(entry.literal) && entry.literal === subject.fields[field].literal)?.account_count ?? 0;
      ensure(knownTotal >= observed_count + partial_count + 2 * conflicting_count && knownTotal <= observed_record_count
        && missingTotal >= partial_count && missingTotal <= missing_record_count
        && comparison.same_literal_count <= sameTotal && comparison.different_literal_count <= knownTotal - sameTotal);
      ensure(new TextEncoder().encode(JSON.stringify(d.entries)).length <= 65_536);
    } else { ensure(d.entries === null && OMIT_REASONS.includes(d.reason as string)); reason = text(d.reason, 200);
      if (reason === 'distinct_literal_limit') ensure(distinct_literal_count > 64); }
    return [field, { label, observed_count, partial_count, missing_count, conflicting_count, record_count, observed_record_count, missing_record_count,
      distribution: { basis: 'accounts_with_literal_any_parcel_row_nonexclusive' as const, status: d.status, reason, distinct_literal_count, entries },
      subject_comparison: comparison }];
  })) as unknown as Summary['fields'];
  return { member_count, fields };
}

/** Optional, exact-context current CAD observations only. This is not a housing
 * dictionary, a similarity factor, legal boundary, historical fact or Apply grant. */
export function checkCustomCohortCadEvidence(value: unknown, catalog: Catalog): CheckedCadRecordedEvidence {
  ensure(value !== null && typeof value === 'object');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'status');
  ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  const available = descriptor.value === 'available';
  ensure(available || descriptor.value === 'details_unavailable');
  const v = object(value, ['cad_baseline_version', 'mapping_version', 'basis', 'authority', 'binding', 'comparison_basis',
    'temporal_basis', 'status', 'reason', ...(available ? ['subject', 'all', 'pockets', 'limitations'] : ['member_count', 'pocket_count'])]);
  ensure(v.cad_baseline_version === 1 && v.mapping_version === 4 && v.basis === 'retained_current_cad_observations'
    && v.authority === 'not_established' && v.comparison_basis === 'exact_literal_same_recorded_county_not_housing_similarity'
    && v.temporal_basis === 'observation_availability_not_historical_validity');
  const b = object(v.binding, ['context_ref', 'captured_at']), ref = object(b.context_ref, ['context_id', 'context_revision', 'context_sha256']);
  ensure(Object.entries(catalog.binding.context_ref).every(([key, expected]) => ref[key] === expected));
  const captured_at = text(b.captured_at, 30), baseInstant = `${captured_at.slice(0, 19)}.000Z`;
  ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(captured_at)
    && Number.isFinite(Date.parse(baseInstant)) && new Date(baseInstant).toISOString() === baseInstant);
  const known = new Map(catalog.pockets.map(p => [p.id, p.member_count]));
  if (catalog.unassigned.member_count) known.set('discovery:unassigned', catalog.unassigned.member_count);
  const binding = { context_ref: { ...catalog.binding.context_ref }, captured_at };
  if (!available) {
    ensure(v.reason === 'presentation_byte_limit' && count(v.member_count, 50_000) === catalog.coverage.discovery_member_count
      && count(v.pocket_count, 129) === known.size);
    return { cad_baseline_version: 1, mapping_version: 4, status: 'details_unavailable', reason: 'presentation_byte_limit',
      binding, member_count: catalog.coverage.discovery_member_count, pocket_count: known.size };
  }
  ensure(v.reason === null);
  const s = object(v.subject, ['in_discovery', 'county_state', 'fields']); ensure(typeof s.in_discovery === 'boolean');
  const inDiscovery = catalog.pockets.some(p => p.account_ids.includes(catalog.subject_membership.account_id))
    || catalog.unassigned.account_ids.includes(catalog.subject_membership.account_id);
  ensure(s.in_discovery === inDiscovery);
  const sf = object(s.fields, FIELDS);
  const fields = Object.fromEntries(FIELDS.map(field => {
    const f = object(sf[field], ['state', 'literal']), observedState = state(f.state), observedLiteral = literal(f.literal, field);
    ensure(['observed', 'partial'].includes(observedState) ? present(observedLiteral) : observedLiteral === null);
    if (!inDiscovery) ensure(observedState === 'missing');
    return [field, { state: observedState, literal: observedLiteral }];
  })) as AvailableCadEvidence['subject']['fields'];
  const subject = { in_discovery: s.in_discovery, county_state: state(s.county_state), fields };
  if (!inDiscovery) ensure(subject.county_state === 'missing');
  const all = summary(object(v.all, ['member_count', 'fields']), catalog.coverage.discovery_member_count, subject);
  const seen = new Set<string>(), pockets = array(v.pockets, 129).map(raw => {
    const p = object(raw, ['id', 'member_count', 'fields']), id = text(p.id, 100), expected = known.get(id);
    ensure(expected !== undefined && !seen.has(id)); seen.add(id); return { id, ...summary(p, expected, subject) };
  });
  ensure(seen.size === known.size && pockets.reduce((sum, p) => sum + p.member_count, 0) === all.member_count);
  for (const field of FIELDS) {
    for (const key of ['observed_count', 'partial_count', 'missing_count', 'conflicting_count',
      'record_count', 'observed_record_count', 'missing_record_count'] as const) {
      ensure(pockets.reduce((sum, p) => sum + p.fields[field][key], 0) === all.fields[field][key]);
    }
    for (const key of ['same_literal_count', 'different_literal_count', 'unavailable_count'] as const) {
      ensure(pockets.reduce((sum, p) => sum + p.fields[field].subject_comparison[key], 0) === all.fields[field].subject_comparison[key]);
    }
    if ([all, ...pockets].every(p => p.fields[field].distribution.entries !== null)) {
      const sums = new Map<string, number>();
      for (const p of pockets) for (const entry of p.fields[field].distribution.entries ?? []) {
        const key = JSON.stringify(entry.literal); sums.set(key, (sums.get(key) ?? 0) + entry.account_count);
      }
      const total = all.fields[field].distribution.entries ?? [];
      ensure(sums.size === total.length && total.every(entry => sums.get(JSON.stringify(entry.literal)) === entry.account_count));
    }
  }
  const limitations = array(v.limitations, LIMITATIONS.length);
  ensure(limitations.length === LIMITATIONS.length && limitations.every((item, i) => item === LIMITATIONS[i]));
  ensure(new TextEncoder().encode(JSON.stringify(value)).length <= 512_000);
  return { cad_baseline_version: 1, mapping_version: 4, status: 'available', reason: null, binding, subject, all, pockets };
}
