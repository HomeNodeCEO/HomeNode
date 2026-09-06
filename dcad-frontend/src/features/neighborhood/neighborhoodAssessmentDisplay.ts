import type { EvidencePreview, MetricPreview, PopulationPreview } from './neighborhoodPreviewModel';

/** Formats a strict subset of producer-normalized records. The workflow owner
 * must bind this fragment to its retained target and preserve the visible notice.
 * This module establishes neither source authority nor permission to apply. */
type Failure = 'invalid_input' | 'input_limit' | 'structure_limit' | 'unsupported_version'
  | 'unsupported_population' | 'unsupported_metadata' | 'invalid_records'
  | 'invalid_references' | 'display_capacity';
type ObjectValue = Record<string, unknown>;
type DateBasis = 'closing_date' | 'contract_date' | 'status_as_of' | 'effective_date';
type Period = { start_date: string; end_date: string; date_basis: DateBasis };
type Scope = { organization_id: string; appraisal_case_id: string; subject_snapshot_id: string; account_id: string };
type AssessmentReference = { id: string; revision: number; evidence_digest_sha256: string };
type Deferred = 'geographic_neighborhood' | 'analysis_geography';
interface Population {
  id: string; revision: string; kind: 'geographic_stock' | 'competitive_stock' | 'transactions' | 'listings';
  member_unit: 'property' | 'canonical_transaction' | 'allocated_property_sale' | 'listing'; definition: string;
  observation_period: Period; member_count: number | null; unique_property_count: number | null;
  property_link_count: number | null; member_set_sha256: string | null; members_resource_id: string;
  pocket_ids: string[]; completeness: 'complete' | 'incomplete' | 'unknown'; reasons: string[]; source_refs: string[];
}
interface Statistic {
  id: string; population_id: string; measurement: string; unit: string; estimator: string;
  estimator_parameters: ObjectValue; value: number | null; status: 'ready' | 'incomplete' | 'unsupported';
  reason: string | null; observed_count: number; missing_count: number; denominator_count: number;
  denominator_basis: 'population_members' | 'unique_properties'; observation_period: Period;
  assessment_tax_year: number | null; uncertainty: ObjectValue; source_refs: string[];
}
interface Snapshot {
  id: string; revision: string; provider: string; content_sha256: string;
  visibility: 'public' | 'organization' | 'assignment'; scope: Scope | null;
  valid_from: string | null; valid_to: string | null; observed_at: string;
  historical_availability: 'contemporaneous' | 'reconstructed' | 'unknown';
}
interface Formatted {
  display_version: 1; status: 'formatted';
  provenance: {
    records_kind: 'all_core_records' | 'candidate_subset'; assessment_reference: AssessmentReference; scope: Scope;
    observation_date_basis: DateBasis; source_authority: 'not_established'; report_eligibility: 'not_assessed';
  };
  display: { effective_date: string; data_cutoff: string; observation_period: { start_date: string; end_date: string };
    populations: PopulationPreview[]; evidence: EvidencePreview[] };
  display_notice: { id: 'assessment-display:v1:context'; label: 'About this evidence'; text: string };
  deferred_evidence_keys: Deferred[];
}
export type NeighborhoodAssessmentDisplay = Readonly<Formatted>
  | Readonly<{ display_version: 1; status: 'unavailable'; reason: Failure }>;

const LIMIT = { bytes: 1_000_000, nodes: 50_000, depth: 24, references: 10_000, evidence: 1_000 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const BASIS: Record<DateBasis, string> = {
  closing_date: 'closing date', contract_date: 'contract date', status_as_of: 'status as of', effective_date: 'effective date',
};
const DISTRIBUTION = ['exact_median', 'exact_quantile', 'arithmetic_mean', 'unsupported'];
// The test checks this literal vocabulary against the core export. No production server import.
const MEASUREMENTS: Record<string, { unit: string; estimators: string[]; label: string }> = Object.fromEntries([
  ['property_count', 'properties', ['count', 'unsupported'], 'Property count'],
  ['transaction_count', 'transactions', ['count', 'unsupported'], 'Transaction count'],
  ['allocated_property_sale_count', 'property_sales', ['count', 'unsupported'], 'Allocated property sale count'],
  ['listing_count', 'listings', ['count', 'unsupported'], 'Listing count'],
  ['unique_property_count', 'properties', ['count', 'unsupported'], 'Unique property count'],
  ['recorded_sale_price', 'USD', DISTRIBUTION, 'Recorded sale price'],
  ['allocated_sale_price', 'USD', DISTRIBUTION, 'Allocated property sale price'],
  ['assessed_market_value', 'USD', DISTRIBUTION, 'Assessed market value'],
  ['predominant_sale_price', 'USD', ['modal_interval', 'unsupported'], 'Predominant sale price'],
  ['sale_price_per_square_foot', 'USD/ft2', DISTRIBUTION, 'Sale price per square foot'],
  ['assessed_value_per_square_foot', 'USD/ft2', DISTRIBUTION, 'Assessed value per square foot'],
  ['gla', 'ft2', DISTRIBUTION, 'Gross living area'],
  ['site_area', 'ft2', DISTRIBUTION, 'Site area'],
  ['age_at_effective_date', 'years', DISTRIBUTION, 'Age at effective date'],
  ['age_at_sale', 'years', DISTRIBUTION, 'Age at sale'],
  ['year_built', 'year', DISTRIBUTION, 'Year built'],
  ['days_on_market', 'days', DISTRIBUTION, 'Days on market'],
  ['sale_coverage_percent', 'percent', ['ratio', 'unsupported'], 'Sale coverage'],
  ['data_coverage_percent', 'percent', ['ratio', 'unsupported'], 'Data coverage'],
  ['cod_percent', 'percent', ['coefficient_of_dispersion', 'unsupported'], 'Coefficient of dispersion'],
  ['underlying_market_change_percent', 'percent', ['unsupported'], 'Underlying market change'],
].map(([key, unit, estimators, label]) => [key, { unit, estimators, label }])) as typeof MEASUREMENTS;
const ESTIMATOR_LABELS: Record<string, string> = {
  count: 'Count', exact_median: 'Median', exact_quantile: 'Quantile (type 7)', arithmetic_mean: 'Arithmetic mean',
  modal_interval: 'Modal interval [lower, upper)', ratio: 'Ratio', coefficient_of_dispersion: 'Coefficient of dispersion',
  unsupported: 'Unsupported estimator',
};
const ROLE_LABELS = { geographic_stock: 'Geographic stock', competitive_stock: 'Competitive stock', transactions: 'Sales sample', listings: 'Listings' };
const POPULATION_KEYS = ['id', 'revision', 'kind', 'member_unit', 'definition', 'observation_period', 'member_count',
  'unique_property_count', 'property_link_count', 'member_set_sha256', 'members_resource_id', 'pocket_ids', 'completeness', 'reasons', 'source_refs'];
const STATISTIC_KEYS = ['id', 'population_id', 'measurement', 'unit', 'estimator', 'estimator_parameters', 'value', 'status',
  'reason', 'observed_count', 'missing_count', 'denominator_count', 'denominator_basis', 'observation_period',
  'assessment_tax_year', 'uncertainty', 'source_refs'];
const SOURCE_KEYS = ['id', 'revision', 'provider', 'content_sha256', 'visibility', 'scope', 'valid_from', 'valid_to', 'observed_at', 'historical_availability'];
const failures = new WeakMap<object, Failure>();
function ensure(condition: unknown, failure: Failure = 'invalid_records'): asserts condition {
  if (!condition) { const error = new Error(); failures.set(error, failure); throw error; }
}
function bytes(value: string, maximum: number, failure: Failure, quoted = false): number {
  ensure(value.length <= maximum, failure);
  let size = quoted ? 2 : 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (quoted && (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code))) size += 2;
    else if (quoted && code < 32) size += 6;
    else if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i); ensure(next >= 0xdc00 && next <= 0xdfff, 'invalid_input'); size += 4;
    } else { ensure(code < 0xdc00 || code > 0xdfff, 'invalid_input'); size += 3; }
    ensure(size <= maximum, failure);
  }
  ensure(size <= maximum, failure); return size;
}

/** Walk only parser-owned or generated JSON, with exact JSON byte/node counts.
 * Input references are charged before any record can fail semantic validation. */
function inspect(value: unknown, failure: Failure, chargeInput = false): { bytes: number; nodes: number } {
  let size = 0, nodes = 0, references = 0;
  const stack = [{ value, depth: 0 }];
  const caps: Record<string, number> = { populations: 100, statistics: 1_000, source_snapshots: 1_000,
    required_evidence_keys: 1_000, source_refs: 1_000, reasons: 1_000, pocket_ids: 5_000 };
  while (stack.length) {
    const item = stack.pop()!;
    ensure(++nodes <= LIMIT.nodes && item.depth <= LIMIT.depth, failure);
    if (item.value === null) size += 4;
    else if (typeof item.value === 'string') size += bytes(item.value, LIMIT.bytes, failure, true);
    else if (typeof item.value === 'number') { ensure(Number.isFinite(item.value), 'invalid_input'); size += String(item.value).length; }
    else if (typeof item.value === 'boolean') size += item.value ? 4 : 5;
    else {
      ensure(typeof item.value === 'object' && item.value !== null, 'invalid_input');
      const array = Array.isArray(item.value), entries = Object.entries(item.value);
      ensure(nodes + stack.length + entries.length <= LIMIT.nodes, failure);
      if (entries.length) ensure(item.depth < LIMIT.depth, failure);
      size += 2 + Math.max(0, entries.length - 1);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        if (!array) {
          size += bytes(key, LIMIT.bytes, failure, true) + 1;
          if (chargeInput) {
            if (Array.isArray(child) && Object.hasOwn(caps, key)) ensure(child.length <= caps[key], 'structure_limit');
            if (['required_evidence_keys', 'source_refs', 'pocket_ids'].includes(key) && Array.isArray(child)) references += child.length;
            if (key === 'population_id' || key === 'members_resource_id') references++;
            ensure(references <= LIMIT.references, 'structure_limit');
          }
        }
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    ensure(size <= LIMIT.bytes, failure);
  }
  return { bytes: size, nodes };
}
function record(value: unknown, keys: string[], failure: Failure = 'invalid_records'): ObjectValue {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), failure);
  const object = value as ObjectValue, actual = Object.keys(object);
  ensure(actual.length === keys.length && keys.every(key => Object.hasOwn(object, key)), failure); return object;
}
function hasControls(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index); if (code < 32 || code === 127) return true;
  }
  return false;
}
function string(value: unknown, maximum = 200): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value === value.trim() && !hasControls(value)); return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], failure: Failure = 'invalid_records'): T {
  ensure(typeof value === 'string' && allowed.includes(value as T), failure); return value as T;
}
function integer(value: unknown, minimum = 0): number { ensure(Number.isSafeInteger(value) && Number(value) >= minimum); return value as number; }
function nullableCount(value: unknown): number | null { return value === null ? null : integer(value); }
function digest(value: unknown): string { const result = string(value); ensure(HASH.test(result)); return result; }
function date(value: unknown): string {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const parsed = new Date(`${value}T00:00:00.000Z`);
  ensure(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value); return value;
}
function period(value: unknown): Period {
  const p = record(value, ['start_date', 'end_date', 'date_basis']);
  const start_date = date(p.start_date), end_date = date(p.end_date);
  const date_basis = choice(p.date_basis, ['closing_date', 'contract_date', 'status_as_of', 'effective_date'] as const);
  ensure(start_date <= end_date); return { start_date, end_date, date_basis };
}
function scope(value: unknown): Scope {
  const r = record(value, ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']);
  for (const key of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id']) ensure(UUID.test(string(r[key])));
  string(r.account_id, 100); return r as Scope;
}
function list(value: unknown, maximum: number): unknown[] {
  ensure(Array.isArray(value)); ensure(value.length <= maximum, 'structure_limit'); return value;
}
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function references(value: unknown, maximum = 1_000): string[] {
  const result = list(value, maximum).map(v => string(v));
  ensure(new Set(result).size === result.length, 'invalid_references'); return result.sort(compare);
}
function byId<T extends { id: string }>(rows: T[]): T[] {
  ensure(new Set(rows.map(r => r.id)).size === rows.length, 'invalid_references');
  return rows.sort((a, b) => compare(a.id, b.id));
}
const samePeriod = (a: Period, b: Period) => a.start_date === b.start_date && a.end_date === b.end_date && a.date_basis === b.date_basis;
function snapshot(value: unknown, inputScope: Scope): Snapshot {
  const r = record(value, SOURCE_KEYS);
  for (const key of ['id', 'revision', 'provider']) string(r[key]); digest(r.content_sha256);
  const visibility = choice(r.visibility, ['public', 'organization', 'assignment']);
  if (visibility === 'public') ensure(r.scope === null);
  else {
    const s = scope(r.scope); ensure(s.organization_id === inputScope.organization_id);
    if (visibility === 'assignment') ensure(Object.keys(s).every(key => s[key as keyof Scope] === inputScope[key as keyof Scope]));
  }
  if (r.valid_from !== null) date(r.valid_from); if (r.valid_to !== null) date(r.valid_to);
  if (r.valid_from !== null && r.valid_to !== null) ensure(String(r.valid_from) <= String(r.valid_to));
  ensure(typeof r.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.observed_at));
  const observed = new Date(r.observed_at); ensure(Number.isFinite(observed.getTime()) && observed.toISOString() === r.observed_at);
  choice(r.historical_availability, ['contemporaneous', 'reconstructed', 'unknown']); return r as unknown as Snapshot;
}
function population(value: unknown, study: Period, effective: string, cutoff: string): Population {
  const r = record(value, POPULATION_KEYS);
  for (const key of ['id', 'revision', 'members_resource_id']) string(r[key]); string(r.definition, 2_000);
  const kind = choice(r.kind, ['geographic_stock', 'competitive_stock', 'transactions', 'listings']);
  choice(r.member_unit, kind === 'transactions' ? ['canonical_transaction', 'allocated_property_sale'] : kind === 'listings' ? ['listing'] : ['property']);
  if (kind === 'listings') ensure(false, 'unsupported_population');
  const p = period(r.observation_period); ensure(p.end_date <= cutoff);
  if (kind === 'transactions') ensure(['closing_date', 'contract_date'].includes(p.date_basis)
    && p.date_basis === study.date_basis && p.start_date >= study.start_date && p.end_date <= study.end_date);
  else ensure(p.start_date === effective && p.end_date === effective && p.date_basis === 'effective_date');
  const members = nullableCount(r.member_count), unique = nullableCount(r.unique_property_count), links = nullableCount(r.property_link_count);
  if (unique !== null && links !== null) ensure(unique <= links);
  if (r.member_unit === 'property') {
    if (members !== null && links !== null) ensure(members === links);
    if (unique !== null && members !== null) ensure(unique === members);
  } else if (members !== null && links !== null) {
    if (r.member_unit === 'allocated_property_sale') ensure(members === links);
    else ensure(links >= members && (members !== 0 || links === 0));
  }
  if (r.member_set_sha256 !== null) digest(r.member_set_sha256);
  const reasons = references(r.reasons), source_refs = references(r.source_refs), pocket_ids = references(r.pocket_ids, 5_000);
  const completeness = choice(r.completeness, ['complete', 'incomplete', 'unknown']);
  if (completeness === 'complete') ensure(members !== null && unique !== null && links !== null && r.member_set_sha256 !== null
    && reasons.length === 0 && (members === 0 || unique > 0) && source_refs.length > 0);
  else ensure(reasons.length > 0);
  return { ...r, observation_period: p, reasons, source_refs, pocket_ids } as unknown as Population;
}
function metadata(s: Statistic): void {
  const failure: Failure = 'unsupported_metadata', params = s.estimator_parameters;
  const finite = (v: unknown): number => { ensure(typeof v === 'number' && Number.isFinite(v), failure); return v; };
  if (s.estimator === 'exact_quantile') {
    record(params, ['convention', 'probability'], failure);
    ensure(params.convention === 'type_7' && finite(params.probability) >= 0 && finite(params.probability) <= 1, failure);
    s.estimator_parameters = { convention: 'type_7', probability: params.probability };
  } else if (s.estimator === 'ratio') {
    record(params, ['numerator_count'], failure);
    ensure(Number.isSafeInteger(params.numerator_count) && Number(params.numerator_count) >= 0
      && Number(params.numerator_count) <= s.denominator_count, failure);
    s.estimator_parameters = { numerator_count: params.numerator_count };
  } else if (s.estimator === 'modal_interval') {
    if (s.status !== 'ready' && s.value === null && params !== null && typeof params === 'object' && Object.keys(params).length === 0) record(params, [], failure);
    else {
      record(params, ['method', 'lower_bound', 'upper_bound', 'bin_width'], failure);
      const lower = finite(params.lower_bound), upper = finite(params.upper_bound), width = finite(params.bin_width);
      ensure(params.method === 'fixed_width_histogram' && lower >= 0 && upper > lower && width === upper - lower
        && (s.value === null || (s.value >= lower && s.value < upper)), failure);
      s.estimator_parameters = { method: 'fixed_width_histogram', lower_bound: lower, upper_bound: upper, bin_width: width };
    }
  } else record(params, [], failure);
  const uncertainty = s.uncertainty;
  ensure(uncertainty !== null && typeof uncertainty === 'object' && !Array.isArray(uncertainty), failure);
  if (Object.keys(uncertainty).length === 0) record(uncertainty, [], failure);
  else {
    record(uncertainty, Object.hasOwn(uncertainty, 'reason') ? ['status', 'reason'] : ['status'], failure);
    ensure(uncertainty.status === 'not_estimated', failure);
    if (Object.hasOwn(uncertainty, 'reason')) {
      const reason = uncertainty.reason;
      ensure(typeof reason === 'string' && reason.length > 0 && reason.length <= 2_000 && reason.trim() === reason
        && !hasControls(reason), failure);
      s.uncertainty = { status: 'not_estimated', reason };
    } else s.uncertainty = { status: 'not_estimated' };
  }
}
function statistic(value: unknown, populations: Map<string, Population>, effective: string): Statistic {
  const r = record(value, STATISTIC_KEYS);
  string(r.id); string(r.population_id);
  const p = populations.get(r.population_id as string); ensure(p, 'invalid_references');
  ensure(typeof r.measurement === 'string' && Object.hasOwn(MEASUREMENTS, r.measurement), 'unsupported_metadata');
  const vocabulary = MEASUREMENTS[r.measurement];
  ensure(r.unit === vocabulary.unit && vocabulary.estimators.includes(r.estimator as string), 'unsupported_metadata');
  choice(r.status, ['ready', 'incomplete', 'unsupported']); choice(r.denominator_basis, ['population_members', 'unique_properties']);
  if (r.value !== null) ensure(typeof r.value === 'number' && Number.isFinite(r.value));
  if (r.reason !== null) string(r.reason, 2_000);
  for (const key of ['observed_count', 'missing_count', 'denominator_count']) integer(r[key]);
  const s = { ...r, observation_period: period(r.observation_period), source_refs: references(r.source_refs) } as unknown as Statistic;
  ensure(samePeriod(s.observation_period, p.observation_period));
  ensure(s.observed_count <= s.denominator_count && s.missing_count === s.denominator_count - s.observed_count);
  const expected = s.denominator_basis === 'unique_properties' ? p.unique_property_count : p.member_count;
  if (expected !== null) ensure(s.denominator_count === expected);
  if (s.denominator_basis === 'unique_properties') ensure(['count', 'unsupported'].includes(s.estimator));
  if (s.measurement === 'unique_property_count') ensure(s.denominator_basis === 'unique_properties');
  const countUnits: Record<string, string> = { property_count: 'property', transaction_count: 'canonical_transaction',
    allocated_property_sale_count: 'allocated_property_sale', listing_count: 'listing' };
  if (Object.hasOwn(countUnits, s.measurement)) ensure(p.member_unit === countUnits[s.measurement] && s.denominator_basis === 'population_members');
  if (['recorded_sale_price', 'allocated_sale_price', 'predominant_sale_price', 'sale_price_per_square_foot', 'age_at_sale'].includes(s.measurement)) ensure(p.kind === 'transactions');
  if (s.measurement === 'recorded_sale_price') ensure(p.member_unit === 'canonical_transaction');
  if (s.measurement === 'allocated_sale_price') ensure(p.member_unit === 'allocated_property_sale');
  if (s.assessment_tax_year !== null) ensure(integer(s.assessment_tax_year, 1800) <= Number(effective.slice(0, 4)));
  if (s.status === 'ready') {
    ensure(p.completeness === 'complete' && expected !== null && s.reason === null && s.value !== null
      && s.estimator !== 'unsupported' && s.source_refs.length > 0);
    if (['assessed_market_value', 'assessed_value_per_square_foot'].includes(s.measurement)) ensure(s.assessment_tax_year !== null);
  } else ensure(s.reason !== null);
  if (s.status === 'unsupported' || s.estimator === 'unsupported') ensure(s.value === null);
  if (s.value !== null && (s.unit !== 'percent' || s.measurement === 'cod_percent')) ensure(s.value >= 0);
  if (s.estimator === 'count' && s.value !== null) ensure(integer(s.value) === s.observed_count);
  if (s.estimator === 'count' && s.status === 'ready') ensure(s.missing_count === 0);
  metadata(s);
  if (['sale_coverage_percent', 'data_coverage_percent'].includes(s.measurement)) {
    if (s.status !== 'ready') ensure(s.value === null);
    if (s.estimator === 'ratio') {
      const numerator = s.estimator_parameters.numerator_count as number;
      if (s.measurement === 'data_coverage_percent') ensure(numerator === s.observed_count);
      if (s.value !== null) ensure(s.denominator_count > 0 && Math.abs(s.value - numerator / s.denominator_count * 100) <= 1e-9);
    }
  }
  if (s.status === 'ready' && s.estimator !== 'count') ensure(s.observed_count > 0
    || (s.measurement === 'data_coverage_percent' && s.estimator === 'ratio' && s.denominator_count > 0));
  return s;
}

function displayText(...parts: string[]): string {
  let length = 0;
  for (const part of parts) { length += part.length; ensure(length <= 5_000, 'display_capacity'); }
  return parts.join('');
}
function textList(values: string[]): string {
  // JSON quoting preserves exact identities, including embedded punctuation.
  let size = 2;
  const parts: string[] = [];
  for (const value of values) {
    const quoted = JSON.stringify(value); size += quoted.length + (parts.length ? 1 : 0);
    ensure(size <= 5_000, 'display_capacity'); parts.push(quoted);
  }
  return `[${parts.join(',')}]`;
}
const periodText = (p: Period) => `${p.start_date} through ${p.end_date}; date basis: ${p.date_basis}`;
function populationDetail(p: Population): string {
  return displayText('Producer-supplied population. ID: ', p.id, '; revision: ', p.revision, '; kind: ', p.kind,
    '; member unit: ', p.member_unit, '; definition: ', p.definition, '; member count: ', String(p.member_count),
    '; unique property count: ', String(p.unique_property_count), '; property link count: ', String(p.property_link_count),
    '; completeness: ', p.completeness, '; reasons: ', textList(p.reasons), '; observation period: ', periodText(p.observation_period),
    '; member-set SHA-256: ', p.member_set_sha256 ?? 'null (unknown)', '; members resource ID: ', p.members_resource_id,
    '; pocket IDs: ', textList(p.pocket_ids), '; source references: ', textList(p.source_refs), '.');
}
function statisticDetail(s: Statistic): string {
  return displayText('Producer-supplied statistic. ID: ', s.id, '; population ID: ', s.population_id, '; measurement: ', s.measurement,
    '; unit: ', s.unit, '; estimator: ', s.estimator, '; supplied value: ', String(s.value), '; status: ', s.status,
    '; reason: ', String(s.reason), '; observed count: ', String(s.observed_count), '; missing count: ', String(s.missing_count),
    '; denominator count: ', String(s.denominator_count), '; denominator basis: ', s.denominator_basis,
    '; observation period: ', periodText(s.observation_period), '; assessment tax year: ', String(s.assessment_tax_year),
    '; estimator parameters: ', JSON.stringify(s.estimator_parameters), '; uncertainty: ', JSON.stringify(s.uncertainty),
    '; source references: ', textList(s.source_refs), '.');
}
function sourceDetail(s: Snapshot): string {
  const suppliedScope = s.scope === null ? 'null' : JSON.stringify({ organization_id: s.scope.organization_id,
    appraisal_case_id: s.scope.appraisal_case_id, subject_snapshot_id: s.scope.subject_snapshot_id, account_id: s.scope.account_id });
  return displayText('Producer-supplied source snapshot. ID: ', s.id, '; revision: ', s.revision, '; provider: ', s.provider,
    '; content SHA-256: ', s.content_sha256, '; visibility: ', s.visibility, '; scope: ', suppliedScope,
    '; valid from: ', String(s.valid_from), '; valid to: ', String(s.valid_to), '; observed at: ', s.observed_at,
    '; historical availability: ', s.historical_availability, '.');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

export function formatNeighborhoodAssessmentDisplay(inputJson: unknown): NeighborhoodAssessmentDisplay {
  try {
    ensure(typeof inputJson === 'string', 'invalid_input'); bytes(inputJson, LIMIT.bytes, 'input_limit');
    const parsed: unknown = JSON.parse(inputJson);
    inspect(parsed, 'structure_limit', true);
    ensure(JSON.stringify(parsed) === inputJson, 'invalid_input');
    const r = record(parsed, ['display_input_version', 'source_contract_version', 'records_kind', 'assessment_reference', 'scope',
      'effective_date', 'data_cutoff', 'observation_period', 'populations', 'statistics', 'source_snapshots', 'required_evidence_keys'], 'invalid_input');
    ensure(r.display_input_version === 1 && r.source_contract_version === 1, 'unsupported_version');
    const records_kind = choice(r.records_kind, ['all_core_records', 'candidate_subset'] as const, 'invalid_input');
    const reference = record(r.assessment_reference, ['id', 'revision', 'evidence_digest_sha256']);
    ensure(UUID.test(string(reference.id))); integer(reference.revision, 1); digest(reference.evidence_digest_sha256);
    const inputScope = scope(r.scope), effective = date(r.effective_date), cutoff = date(r.data_cutoff), study = period(r.observation_period);
    ensure(study.end_date <= cutoff && cutoff <= effective);
    const rawPopulations = list(r.populations, 100), rawStatistics = list(r.statistics, 1_000), rawSources = list(r.source_snapshots, 1_000);
    const required = list(r.required_evidence_keys, 1_000).map(key => string(key, 300));
    ensure(new Set(required).size === required.length, 'invalid_references');
    const deferred = required.filter((key): key is Deferred => key === 'geographic_neighborhood' || key === 'analysis_geography').sort(compare);
    ensure(rawPopulations.length + rawStatistics.length + rawSources.length + deferred.length <= LIMIT.evidence, 'structure_limit');
    const sources = byId(rawSources.map(s => snapshot(s, inputScope)));
    const populations = byId(rawPopulations.map(p => population(p, study, effective, cutoff)));
    const populationMap = new Map(populations.map(p => [p.id, p]));
    const statistics = byId(rawStatistics.map(s => statistic(s, populationMap, effective)));
    const sourceIds = new Set(sources.map(s => s.id));
    for (const item of [...populations, ...statistics]) for (const id of item.source_refs) ensure(sourceIds.has(id), 'invalid_references');
    const keys = new Set([...populations.map(p => `population:${p.id}`), ...statistics.map(s => `statistic:${s.id}`), ...sources.map(s => `source:${s.id}`)]);
    for (const key of required) {
      if (key === 'geographic_neighborhood' || key === 'analysis_geography') continue;
      const prefix = ['population:', 'statistic:', 'source:'].find(p => key.startsWith(p));
      ensure(prefix !== undefined, 'invalid_references');
      const id = key.slice(prefix.length);
      ensure(id.length > 0 && id.length <= 200 && id.trim() === id && !hasControls(id), 'invalid_references');
      ensure(keys.has(key), 'invalid_references');
    }
    const outputReferences = populations.length + 3 * statistics.length + statistics.reduce((n, s) => n + s.source_refs.length, 0) + deferred.length;
    ensure(outputReferences <= LIMIT.references, 'display_capacity');
    const result: Formatted = {
      display_version: 1, status: 'formatted',
      provenance: { records_kind, assessment_reference: { id: reference.id as string, revision: reference.revision as number,
        evidence_digest_sha256: reference.evidence_digest_sha256 as string }, scope: { organization_id: inputScope.organization_id,
        appraisal_case_id: inputScope.appraisal_case_id, subject_snapshot_id: inputScope.subject_snapshot_id, account_id: inputScope.account_id },
      observation_date_basis: study.date_basis, source_authority: 'not_established', report_eligibility: 'not_assessed' },
      display: { effective_date: effective, data_cutoff: cutoff, observation_period: { start_date: study.start_date, end_date: study.end_date }, populations: [], evidence: [] },
      display_notice: { id: 'assessment-display:v1:context', label: 'About this evidence', text: displayText(
        records_kind === 'candidate_subset' ? 'Supplied candidate evidence subset; other assessment records are not shown.'
          : 'Supplied core population, statistic and source records; this is not a complete assessment display.',
        ' Observation date basis: ', BASIS[study.date_basis], '. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.') },
      deferred_evidence_keys: deferred,
    };
    // Exact incremental serialized growth: each append replaces an existing []
    // or adds one comma. No unlimited complete-output string is constructed.
    const budget = inspect(result, 'display_capacity');
    function append<T>(array: T[], value: T): void {
      const added = inspect(value, 'display_capacity');
      budget.bytes += added.bytes + (array.length ? 1 : 0); budget.nodes += added.nodes;
      ensure(budget.bytes <= LIMIT.bytes && budget.nodes <= LIMIT.nodes, 'display_capacity'); array.push(value);
    }
    const statisticsByPopulation = new Map<string, Statistic[]>();
    for (const s of statistics) {
      const rows = statisticsByPopulation.get(s.population_id) ?? []; rows.push(s); statisticsByPopulation.set(s.population_id, rows);
    }
    for (const p of populations) {
      const detail = populationDetail(p), evidence_key = `population:${p.id}`;
      const row: PopulationPreview = { id: p.id, role: p.kind === 'transactions' ? 'sales_sample' : p.kind as PopulationPreview['role'],
        definition: p.definition, member_count: p.member_count, unique_property_count: p.unique_property_count,
        coverage_text: detail, evidence_key, metrics: [] };
      append(result.display.populations, row);
      append(result.display.evidence, { key: evidence_key, kind: 'population', id: p.id, label: ROLE_LABELS[p.kind],
        observation_text: periodText(p.observation_period), support: 'unknown', detail });
      for (const s of statisticsByPopulation.get(p.id) ?? []) {
        const statisticKey = `statistic:${s.id}`;
        const display_value = s.value === null ? null : s.estimator === 'modal_interval'
          ? displayText('[', String(s.estimator_parameters.lower_bound), ', ', String(s.estimator_parameters.upper_bound), '); supplied value ', String(s.value)) : String(s.value);
        const metric: MetricPreview = { id: s.id, population_id: p.id, label: MEASUREMENTS[s.measurement].label, display_value,
          unit: s.unit, estimator_label: ESTIMATOR_LABELS[s.estimator], status: s.status === 'ready' ? 'available' : s.status === 'incomplete' ? 'needs_review' : 'not_available',
          evidence_keys: [statisticKey, evidence_key, ...s.source_refs.map(id => `source:${id}`)] };
        append(row.metrics, metric);
        append(result.display.evidence, { key: statisticKey, kind: 'statistic', id: s.id, label: MEASUREMENTS[s.measurement].label,
          observation_text: periodText(s.observation_period), support: 'unknown', detail: statisticDetail(s) });
      }
    }
    for (const [index, s] of sources.entries()) append(result.display.evidence, { key: `source:${s.id}`, kind: 'source', id: s.id,
      label: `Source ${index + 1}`, observation_text: `Observed at: ${s.observed_at}`, support: 'unknown', detail: sourceDetail(s) });
    const kindOrder = { population: 0, statistic: 1, source: 2, geographic_neighborhood: 3, analysis_geography: 4 };
    result.display.evidence.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || compare(a.id ?? '', b.id ?? ''));
    const final = inspect(result, 'display_capacity');
    ensure(final.bytes === budget.bytes && final.nodes === budget.nodes, 'display_capacity');
    return freeze(result);
  } catch (error) {
    const reason = typeof error === 'object' && error !== null ? failures.get(error) ?? 'invalid_input' : 'invalid_input';
    return Object.freeze({ display_version: 1, status: 'unavailable', reason });
  }
}
