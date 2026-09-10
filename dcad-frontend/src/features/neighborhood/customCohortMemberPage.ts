import { checkCustomCohortPrivateSales } from './customCohortPrivateSales.ts';
import type { CheckedPrivateSalesObservations } from './customCohortPrivateSales';
import type { CustomCohortContextRef, CustomCohortPreviewBinding, CustomCohortPreviewInput } from './customCohortPreviewController';

export type CustomCohortMemberKind = 'stock' | 'transactions' | 'omitted_transactions' | 'source_reported';
export type CustomCohortMemberPopulation = { readonly group: 'all' | 'selected'; readonly kind: CustomCohortMemberKind }
  | { readonly group: 'pocket'; readonly kind: CustomCohortMemberKind; readonly pocket_id: string };
/** total_count comes from the already checked summary inspection descriptor, not this response. */
export type CustomCohortMemberExpectation = CustomCohortMemberPopulation & { readonly total_count: number };
export interface CustomCohortMemberPageRequest { readonly limit: number; readonly after_member_id: string | null }
export interface CustomCohortMemberObservation {
  readonly state: 'observed' | 'missing' | 'conflicting' | 'invalid';
  readonly value: number | null; readonly exact_value: string | null; readonly display_value: string;
  readonly label: string; readonly unit: string | null; readonly currency: null;
  readonly observed_record_count: number; readonly missing_record_count: number; readonly invalid_record_count: number;
}
interface MemberBase {
  readonly member_id: string;
  readonly provenance: { readonly status: 'retained_references_not_verification'; readonly reference_count: number };
  readonly temporal_support: 'not_established';
  readonly observations: Readonly<Record<string, CustomCohortMemberObservation>>;
}
export interface CustomCohortStockMember extends MemberBase { readonly account_id: string; readonly parcel_object_count: number }
export interface CustomCohortSourceMember extends MemberBase {
  readonly associated_account_count: number; readonly has_source_disagreement: boolean; readonly canonical_transaction_count: number;
}
export interface CustomCohortTransactionMember extends MemberBase {
  readonly associated_account_count: number; readonly has_source_disagreement: boolean;
  readonly sale_date: string | null; readonly disposition: 'in_period' | 'outside_period' | 'missing_date' | 'conflicting_date';
  readonly multiple_parcel_evidence: boolean; readonly unresolved_link_count: number;
  readonly membership_complete: null; readonly market_eligible: null;
  readonly amount_semantics: 'stored_canonical_total_not_verified_property_price_or_consideration';
}
export type CustomCohortInspectedMember = CustomCohortStockMember | CustomCohortSourceMember | CustomCohortTransactionMember;
export interface CustomCohortInspectedPage {
  readonly presentation_version: 1; readonly preview_version: 1; readonly status: 'observations_only';
  readonly binding: { readonly context_ref: CustomCohortContextRef; readonly selection_revision: number; readonly selection_sha256: string };
  readonly effective_date: string; readonly observation_period: { readonly start_date: string; readonly end_date: string }; readonly captured_at: string;
  readonly authority: 'not_established'; readonly provider_coverage: 'not_established'; readonly historical_applicability: 'not_established';
  readonly metric_readiness: 'descriptive_calculation_only_not_report_readiness';
  readonly support_gaps: readonly string[]; readonly unavailable_metrics: Readonly<Record<string, string>>;
  readonly apply: { readonly status: 'blocked'; readonly reasons: readonly string[] };
  readonly contents: 'member_page'; readonly population: CustomCohortMemberPopulation; readonly population_id: string;
  readonly member_unit: 'account' | 'canonical_transaction' | 'source_record';
  readonly total_count: number; readonly returned_count: number; readonly start_index: number; readonly end_index_exclusive: number;
  readonly is_full_population: boolean; readonly has_more: boolean; readonly next_after_member_id: string | null;
  readonly members: readonly CustomCohortInspectedMember[];
}
export interface CheckedCustomCohortMemberPage {
  readonly binding: CustomCohortPreviewBinding; readonly page: CustomCohortInspectedPage;
  readonly apply: { readonly status: 'blocked'; readonly reasons: readonly ['observation_preview_only'] };
  readonly private_sales?: CheckedPrivateSalesObservations;
}
export interface CustomCohortMemberContinuation {
  readonly population_id: string; readonly total_count: number; readonly end_index_exclusive: number;
  readonly next_after_member_id: string | null;
}
export const CUSTOM_COHORT_MEMBER_PAGE_LIMITS = Object.freeze({ pageBytes: 256000, pageMembers: 50, populationMembers: 100000 });
const L = CUSTOM_COHORT_MEMBER_PAGE_LIMITS, UTF8 = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/, MEMBER = /^member:[a-f0-9]{64}$/, POPULATION = /^population:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UNAVAILABLE = ['property_sale_price', 'sale_price_per_square_foot', 'age_at_sale', 'age_at_effective_date', 'predominant_value', 'market_trend', 'reliability'];
const STOCK = { year_built: 'year', gla_sqft: 'ft2', site_area_sqft: 'ft2', assessed_value: null } as const;
const SOURCE = { living_area: null, lot_size_area: null, year_built: 'year', bedrooms_total: 'count', bathrooms_total_integer: 'count',
  bathrooms_full: 'count', bathrooms_half: 'count', garage_spaces: 'count', days_on_market: 'days', current_price: null } as const;
const TRANSACTION = { recorded_total_price: null } as const;
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const yearFormat = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 2 });
interface SharedProof { binding: CustomCohortPreviewBinding; population: string; header: string; privateSales: string | undefined }
interface ContinuationProof { shared: SharedProof; populationId: string; total: number; end: number; next: string | null;
  hasMore: boolean; ids: ReadonlySet<string>; lastAccount: string | null; previous: ContinuationProof | undefined }
// Weak ownership proofs avoid accepting a caller-constructed predecessor. Each
// token retains at most 50 opaque IDs and shares fixed header data across pages.
const admitted = new WeakMap<CheckedCustomCohortMemberPage | CustomCohortMemberContinuation, ContinuationProof>();
function check(ok: unknown): asserts ok { if (!ok) throw new TypeError('invalid_custom_cohort_member_page'); }
type Row = Record<string, unknown>;
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): Row {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const row = value as Row, actual = Reflect.ownKeys(row);
  check(actual.every(key => typeof key === 'string' && (keys.includes(key) || optional.includes(key))) && keys.every(key => Object.hasOwn(row, key)));
  for (const key of actual) { const d = Object.getOwnPropertyDescriptor(row, key); check(d?.enumerable && Object.hasOwn(d, 'value')); }
  return row;
}
function text(value: unknown, max = 1024): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && UTF8.encode(value).length <= max
    && Array.from(value).every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)); return value;
}
function pattern(value: unknown, regex: RegExp): string { check(typeof value === 'string' && regex.test(value)); return value; }
function count(value: unknown, max: number = L.populationMembers): number { check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max); return Number(value); }
function strings(value: unknown): readonly string[] { check(Array.isArray(value) && value.length <= 64); value.forEach(v => text(v)); return value; }
function date(value: unknown): string {
  const v = pattern(value, /^\d{4}-\d\d-\d\d$/), d = new Date(`${v}T00:00:00.000Z`);
  check(Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v); return v;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
/** Meter and detach JSON data without invoking accessors/toJSON. Byte accounting
 * is of the complete JSON representation, including escaped strings and keys. */
function copyJson(value: unknown, maximum: number, nodesMaximum = 100000): unknown {
  let bytes = 0, nodes = 0; const seen = new WeakSet<object>();
  const charge = (n: number) => { bytes += n; check(bytes <= maximum); };
  const stringBytes = (s: string) => { check(s.length <= maximum); charge(UTF8.encode(JSON.stringify(s)).length); };
  const visit = (v: unknown, depth: number): unknown => {
    check(++nodes <= nodesMaximum && depth <= 24);
    if (v === null || typeof v === 'boolean') { charge(v === null || v === true ? 4 : 5); return v; }
    if (typeof v === 'number') { check(Number.isFinite(v)); charge(JSON.stringify(v).length); return v; }
    if (typeof v === 'string') { stringBytes(v); return v; }
    check(v && typeof v === 'object' && !seen.has(v)); seen.add(v);
    if (Array.isArray(v)) {
      check(v.length <= nodesMaximum && Reflect.ownKeys(v).length === v.length + 1); charge(2 + Math.max(0, v.length - 1));
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i)); check(d?.enumerable && Object.hasOwn(d, 'value')); return visit(d.value, depth + 1);
      });
    }
    check(Object.getPrototypeOf(v) === Object.prototype); const keys = Reflect.ownKeys(v), result: Row = {};
    check(keys.every(key => typeof key === 'string')); keys.sort();
    charge(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      check(typeof key === 'string'); const d = Object.getOwnPropertyDescriptor(v, key); check(d?.enumerable && Object.hasOwn(d, 'value'));
      stringBytes(key); charge(1); Object.defineProperty(result, key, { value: visit(d.value, depth + 1), enumerable: true });
    }
    return result;
  };
  return visit(value, 0);
}
function sameContext(value: unknown, expected: CustomCohortContextRef): void {
  const ref = exact(value, ['context_id', 'context_revision', 'context_sha256']);
  check(pattern(ref.context_id, UUID) === expected.context_id && ref.context_revision === '1' && ref.context_revision === expected.context_revision
    && pattern(ref.context_sha256, HASH) === expected.context_sha256);
}
function inputOf(value: CustomCohortPreviewInput): CustomCohortPreviewInput {
  const input = exact(copyJson(value, 3904096, 210000), ['accountId', 'assignmentFileId', 'contextRef', 'selection']);
  text(input.accountId, 100); const file = pattern(input.assignmentFileId, /^[1-9]\d{0,18}$/); check(BigInt(file) <= 9223372036854775807n);
  sameContext(input.contextRef, input.contextRef as CustomCohortContextRef);
  const selection = exact(input.selection, ['revision', 'pockets']); check(count(selection.revision, Number.MAX_SAFE_INTEGER) > 0);
  check(Array.isArray(selection.pockets) && selection.pockets.length <= 128); let memberships = 0; const ids = new Set<string>();
  for (const value of selection.pockets) {
    const pocket = exact(value, ['id', 'label', 'account_ids']), id = text(pocket.id, 200); text(pocket.label, 200);
    check(!ids.has(id)); ids.add(id); check(Array.isArray(pocket.account_ids) && pocket.account_ids.length <= 50000);
    check((memberships += pocket.account_ids.length) <= 100000); const accounts = pocket.account_ids.map(id => text(id, 100));
    check(new Set(accounts).size === accounts.length);
  }
  return input as unknown as CustomCohortPreviewInput;
}
function populationOf(value: unknown, expectation = false): CustomCohortMemberPopulation {
  const base = exact(value, ['group', 'kind'], ['pocket_id', ...(expectation ? ['total_count'] : [])]);
  check(['all', 'selected', 'pocket'].includes(String(base.group)) && ['stock', 'transactions', 'omitted_transactions', 'source_reported'].includes(String(base.kind)));
  check(Object.hasOwn(base, 'pocket_id') === (base.group === 'pocket'));
  if (base.group === 'pocket') text(base.pocket_id, 800);
  if (expectation) { check(Object.hasOwn(base, 'total_count')); count(base.total_count); }
  return base as unknown as CustomCohortMemberPopulation;
}
const populationKey = (p: CustomCohortMemberPopulation) => JSON.stringify([p.group, p.kind, p.group === 'pocket' ? p.pocket_id : null]);
function metricOf(value: unknown, unit: string | null): void {
  const c = exact(value, ['state', 'value', 'exact_value', 'display_value', 'label', 'unit', 'currency',
    'observed_record_count', 'missing_record_count', 'invalid_record_count']);
  check(['observed', 'missing', 'conflicting', 'invalid'].includes(String(c.state)) && c.unit === unit && c.currency === null); text(c.label);
  const observed = count(c.observed_record_count), invalid = count(c.invalid_record_count);
  check(observed + invalid + count(c.missing_record_count) <= L.populationMembers);
  if (c.state === 'observed') {
    check(typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0 && observed > 0 && invalid === 0);
    const exact = text(c.exact_value, 128); check(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(exact) && Number(exact) === c.value);
    check(c.display_value === (unit === 'year' ? yearFormat : numberFormat).format(c.value));
  } else {
    check(c.value === null && c.exact_value === null && c.display_value === 'Unavailable');
    if (c.state === 'missing') check(observed === 0 && invalid === 0);
    if (c.state === 'invalid') check(invalid > 0);
    if (c.state === 'conflicting') check(observed >= 2);
  }
}
function memberOf(value: unknown, kind: CustomCohortMemberKind, period: CustomCohortInspectedPage['observation_period']): void {
  const common = ['member_id', 'provenance', 'temporal_support', 'observations'];
  const keys = kind === 'stock' ? ['account_id', 'parcel_object_count'] : ['associated_account_count', 'has_source_disagreement',
    ...(kind === 'source_reported' ? ['canonical_transaction_count'] : ['sale_date', 'disposition', 'multiple_parcel_evidence', 'unresolved_link_count',
      'membership_complete', 'market_eligible', 'amount_semantics'])];
  const row = exact(value, [...common, ...keys]); pattern(row.member_id, MEMBER); check(row.temporal_support === 'not_established');
  const provenance = exact(row.provenance, ['status', 'reference_count']);
  check(provenance.status === 'retained_references_not_verification'); count(provenance.reference_count);
  const metrics = kind === 'stock' ? STOCK : kind === 'source_reported' ? SOURCE : TRANSACTION;
  const observations = exact(row.observations, Object.keys(metrics)); for (const [key, unit] of Object.entries(metrics)) metricOf(observations[key], unit);
  if (kind === 'stock') { text(row.account_id, 400); count(row.parcel_object_count); return; }
  count(row.associated_account_count); check(typeof row.has_source_disagreement === 'boolean');
  if (kind === 'source_reported') { count(row.canonical_transaction_count); return; }
  count(row.unresolved_link_count); check(typeof row.multiple_parcel_evidence === 'boolean' && row.membership_complete === null && row.market_eligible === null
    && row.amount_semantics === 'stored_canonical_total_not_verified_property_price_or_consideration');
  check(['in_period', 'outside_period', 'missing_date', 'conflicting_date'].includes(String(row.disposition)));
  check((kind === 'transactions') === (row.disposition === 'in_period'));
  if (row.disposition === 'missing_date' || row.disposition === 'conflicting_date') check(row.sale_date === null);
  else { const d = date(row.sale_date), inside = d >= period.start_date && d <= period.end_date; check(inside === (row.disposition === 'in_period')); }
}
function stableHeader(page: CustomCohortInspectedPage): string {
  return JSON.stringify([page.effective_date, page.observation_period.start_date, page.observation_period.end_date, page.captured_at,
    page.support_gaps, UNAVAILABLE.map(key => page.unavailable_metrics[key]), page.apply]);
}
/** Checks a read-only member projection, not source authority or report eligibility.
 * Subsequent pages require the actual checked predecessor; cached back pages may
 * be reused. Cursor/index continuity is not a cryptographic proof of source facts. */
export function checkCustomCohortMemberPage(value: unknown, inputValue: CustomCohortPreviewInput, selectionSha256: string,
  expectedPopulation: CustomCohortMemberExpectation, expectedPage: CustomCohortMemberPageRequest,
  previousPage?: CheckedCustomCohortMemberPage | CustomCohortMemberContinuation): CheckedCustomCohortMemberPage {
  const input = inputOf(inputValue); pattern(selectionSha256, HASH);
  const expected = populationOf(copyJson(expectedPopulation, 4096), true) as CustomCohortMemberExpectation;
  if (expected.group === 'pocket') check(input.selection.pockets.some(p => p.id === expected.pocket_id));
  const request = exact(copyJson(expectedPage, 1024), ['limit', 'after_member_id']); check(count(request.limit, L.pageMembers) > 0);
  if (request.after_member_id !== null) pattern(request.after_member_id, MEMBER);
  const response = exact(copyJson(value, L.pageBytes + 2 * 1024 * 1024 + 4096),
    ['status', 'target', 'context_ref', 'selection_revision', 'subject_freshness', 'page', 'apply'], ['private_sales']);
  check(response.status === 'members' && response.subject_freshness === 'matched' && response.selection_revision === input.selection.revision);
  const target = exact(response.target, ['account_id', 'assignment_file_id']);
  check(target.account_id === input.accountId && target.assignment_file_id === input.assignmentFileId); sameContext(response.context_ref, input.contextRef);
  const outerApply = exact(response.apply, ['status', 'reasons']);
  check(outerApply.status === 'blocked' && JSON.stringify(outerApply.reasons) === '["observation_preview_only"]');
  const raw = exact(copyJson(response.page, L.pageBytes), ['presentation_version', 'preview_version', 'status', 'binding', 'effective_date',
    'observation_period', 'captured_at', 'authority', 'provider_coverage', 'historical_applicability', 'metric_readiness', 'support_gaps',
    'unavailable_metrics', 'apply', 'contents', 'population', 'population_id', 'member_unit', 'total_count', 'returned_count', 'start_index',
    'end_index_exclusive', 'is_full_population', 'has_more', 'next_after_member_id', 'members']);
  check(raw.presentation_version === 1 && raw.preview_version === 1 && raw.status === 'observations_only' && raw.contents === 'member_page'
    && raw.authority === 'not_established' && raw.provider_coverage === 'not_established' && raw.historical_applicability === 'not_established'
    && raw.metric_readiness === 'descriptive_calculation_only_not_report_readiness');
  const binding = exact(raw.binding, ['context_ref', 'selection_revision', 'selection_sha256']); sameContext(binding.context_ref, input.contextRef);
  check(binding.selection_revision === input.selection.revision && binding.selection_sha256 === selectionSha256);
  const period = exact(raw.observation_period, ['start_date', 'end_date']);
  check(date(period.start_date) <= date(period.end_date) && String(period.end_date) <= date(raw.effective_date));
  const captured = pattern(raw.captured_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/);
  check(Number.isFinite(Date.parse(captured)) && new Date(captured).toISOString() === `${captured.slice(0, 23)}Z`);
  strings(raw.support_gaps); const unavailable = exact(raw.unavailable_metrics, UNAVAILABLE); UNAVAILABLE.forEach(key => text(unavailable[key]));
  const apply = exact(raw.apply, ['status', 'reasons']); check(apply.status === 'blocked' && strings(apply.reasons).length > 0);
  check(populationKey(populationOf(raw.population)) === populationKey(expected)); pattern(raw.population_id, POPULATION);
  check(raw.member_unit === (expected.kind === 'stock' ? 'account' : expected.kind === 'source_reported' ? 'source_record' : 'canonical_transaction'));
  const total = count(raw.total_count), start = count(raw.start_index), end = count(raw.end_index_exclusive), returned = count(raw.returned_count, L.pageMembers);
  check(total === expected.total_count && start <= end && end <= total && returned === end - start && returned === Math.min(Number(request.limit), total - start)
    && raw.has_more === (end < total) && raw.is_full_population === (start === 0 && end === total));
  check(Array.isArray(raw.members) && raw.members.length === returned);
  const page = raw as unknown as CustomCohortInspectedPage;
  raw.members.forEach(row => memberOf(row, expected.kind, page.observation_period));
  const ids = page.members.map(row => row.member_id); check(new Set(ids).size === ids.length);
  check(raw.next_after_member_id === (raw.has_more ? ids.at(-1) : null));
  const prior = previousPage ? admitted.get(previousPage) : undefined;
  if (request.after_member_id === null) { check(start === 0 && previousPage === undefined); }
  else {
    check(prior && prior.hasMore && prior.next === request.after_member_id && prior.end === start
      && prior.populationId === page.population_id && prior.total === total && prior.shared.population === populationKey(page.population)
      && prior.shared.binding.accountId === input.accountId && prior.shared.binding.assignmentFileId === input.assignmentFileId
      && prior.shared.binding.selectionRevision === input.selection.revision && prior.shared.binding.selectionFingerprint === selectionSha256
      && prior.shared.header === stableHeader(page)); sameContext(prior.shared.binding.contextRef, input.contextRef);
    // A chain retains only opaque IDs, not prior observation payloads. At most
    // 100000 admitted member identities can precede this bounded page.
    for (let ancestor: ContinuationProof | undefined = prior; ancestor; ancestor = ancestor.previous)
      check(ids.every(id => !ancestor.ids.has(id)));
  }
  if (expected.kind === 'stock') {
    const accounts = (page.members as readonly CustomCohortStockMember[]).map(row => row.account_id);
    check(accounts.every((id, index) => index === 0 || accounts[index - 1] < id));
    if (prior?.lastAccount !== null && prior?.lastAccount !== undefined && accounts.length) check(prior.lastAccount < accounts[0]);
    if (expected.group !== 'all') {
      const chosen = new Set(input.selection.pockets.filter(p => expected.group !== 'pocket' || p.id === expected.pocket_id).flatMap(p => [...p.account_ids]));
      check(total === chosen.size && accounts.every(id => chosen.has(id)));
    }
  }
  const privateSales = Object.hasOwn(response, 'private_sales') ? checkCustomCohortPrivateSales(response.private_sales, input, selectionSha256) : undefined;
  if (privateSales) check(privateSales.effective_date === page.effective_date && privateSales.observation_period.start_date === page.observation_period.start_date
    && privateSales.observation_period.end_date === page.observation_period.end_date);
  const privateSignature = JSON.stringify(privateSales); if (prior) check(prior.shared.privateSales === privateSignature);
  const result = freeze({ binding: { accountId: input.accountId, assignmentFileId: input.assignmentFileId, contextRef: input.contextRef,
    selectionRevision: input.selection.revision, selectionFingerprint: selectionSha256 }, page,
    apply: outerApply as unknown as CheckedCustomCohortMemberPage['apply'], ...(privateSales ? { private_sales: privateSales } : {}) });
  admitted.set(result, { shared: prior?.shared ?? { binding: result.binding, population: populationKey(page.population),
    header: stableHeader(page), privateSales: privateSignature }, populationId: page.population_id, total, end,
    next: page.next_after_member_id, hasMore: page.has_more, ids: new Set(ids), previous: prior,
    lastAccount: expected.kind === 'stock' ? (page.members.at(-1) as CustomCohortStockMember | undefined)?.account_id ?? null : null });
  return result;
}

/** Retain this instead of a full page for bounded Back/Next history. The returned
 * scalar object is useful for navigation but only its original identity is a
 * valid continuation; serialization/cloning does not recreate checked proof. */
export function createCustomCohortMemberContinuation(page: CheckedCustomCohortMemberPage): CustomCohortMemberContinuation {
  const proof = admitted.get(page); check(proof);
  const token = Object.freeze({ population_id: proof.populationId, total_count: proof.total,
    end_index_exclusive: proof.end, next_after_member_id: proof.next });
  admitted.set(token, proof); return token;
}
