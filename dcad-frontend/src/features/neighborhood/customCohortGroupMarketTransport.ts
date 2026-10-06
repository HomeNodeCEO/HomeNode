import { createCustomCohortJsonTransport } from './customCohortPreviewTransport.ts';
import { prepareCustomCohortRecordedGroupWrite, prepareCustomCohortGroupSelectionReference } from './customCohortRecordedGroupTransport.ts';
import type { CustomCohortRecordedGroupSummary, CustomCohortGroupSelectionRef } from './customCohortRecordedGroupTransport';
import type { MarketConditionsResponse, MarketContextOverride } from '@/lib/api';

export interface CustomCohortGroupMarketWindow {
  readonly asOf: string; readonly periodMonths: 12 | 24 | 36;
  readonly contextOverride: MarketContextOverride | null;
}
export interface CustomCohortGroupMarketInput extends CustomCohortRecordedGroupSummary, CustomCohortGroupMarketWindow {}
export type CustomCohortGroupMarketResponse = MarketConditionsResponse & {
  readonly exploration_binding: { readonly context_ref: CustomCohortRecordedGroupSummary['contextRef'];
    readonly selection_revision: number; readonly selection_sha256: string };
  readonly exploration_selection_ref: CustomCohortGroupSelectionRef;
};
const PROBE = '10000000-0000-4000-8000-000000000001';
const OVERRIDE = ['source', 'address', 'city', 'county', 'postal_code', 'latitude', 'longitude', 'source_account_id', 'review_note'];
const encoder = new TextEncoder();
// Decoder-owned immutable receipts only: not a source/result lookup or retry cache.
const receipts = new WeakMap<object, string>();
function fail(): never { throw new TypeError('invalid_custom_cohort_group_market'); }
const requireThat: (value: unknown) => asserts value = value => { if (!value) fail(); };
function own(value: unknown, keys: readonly string[], optional = false) {
  requireThat(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && (optional || Reflect.ownKeys(value).length === keys.length));
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    requireThat(d?.enumerable && Object.hasOwn(d, 'value')); result[String(key)] = d.value;
  }
  return result;
}

/** Explicit calendar date only: the browser must not silently substitute today
 * or the report effective date for the appraiser's chosen study window. */
export function prepareCustomCohortGroupMarketWindow(value: unknown): CustomCohortGroupMarketWindow {
  const v = own(value, ['asOf', 'periodMonths', 'contextOverride']);
  requireThat(typeof v.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.asOf)
    && typeof v.periodMonths === 'number' && [12, 24, 36].includes(v.periodMonths));
  const date = new Date(`${v.asOf}T00:00:00.000Z`);
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v.asOf && date.getUTCFullYear() >= 100);
  const override = v.contextOverride === null ? null : own(v.contextOverride, OVERRIDE, true);
  if (override) {
    requireThat(typeof override.source === 'string' && ['manual', 'dcad_related_parcel'].includes(override.source));
    for (const [key, entry] of Object.entries(override)) {
      requireThat(key === 'latitude' || key === 'longitude'
        ? entry === null || (typeof entry === 'number' && Number.isFinite(entry))
        : entry === null || (typeof entry === 'string' && entry.length <= 1000));
    }
  }
  return Object.freeze({ asOf: v.asOf, periodMonths: v.periodMonths as 12 | 24 | 36,
    contextOverride: override && Object.freeze(override) as unknown as MarketContextOverride | null });
}
function prepare(value: CustomCohortGroupMarketInput) {
  const v = own(value, ['accountId', 'assignmentFileId', 'contextRef', 'selectionRef', 'asOf', 'periodMonths', 'contextOverride']);
  const bound = prepareCustomCohortRecordedGroupWrite({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, operationId: PROBE, expectedSelectionRef: null, includedRecordedGroupIds: [] });
  return Object.freeze({ accountId: bound.accountId, assignmentFileId: bound.assignmentFileId, contextRef: bound.contextRef,
    selectionRef: prepareCustomCohortGroupSelectionReference(v.selectionRef),
    ...prepareCustomCohortGroupMarketWindow({ asOf: v.asOf, periodMonths: v.periodMonths, contextOverride: v.contextOverride }) });
}

// Only detached JSON data from a bounded response reaches consumers. This copy
// does not freeze a test port's caller-owned object or execute data accessors.
function detached(value: unknown) {
  let nodes = 0;
  function copy(v: unknown, depth = 0): unknown {
    requireThat(++nodes <= 131072 && depth <= 32);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') { requireThat(Number.isFinite(v)); return v; }
    requireThat(v && typeof v === 'object');
    if (Array.isArray(v)) {
      requireThat(Object.getPrototypeOf(v) === Array.prototype && v.length <= 50000 && Reflect.ownKeys(v).length === v.length + 1);
      const out = [];
      for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i));
        requireThat(d?.enumerable && Object.hasOwn(d, 'value')); out.push(copy(d.value, depth + 1)); }
      return Object.freeze(out);
    }
    requireThat(Object.getPrototypeOf(v) === Object.prototype);
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) { const d = Object.getOwnPropertyDescriptor(v, key);
      requireThat(typeof key === 'string' && d?.enumerable && Object.hasOwn(d, 'value'));
      Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true }); }
    return Object.freeze(out);
  }
  const result = copy(value);
  requireThat(encoder.encode(JSON.stringify(result)).length <= 4_000_000); return result;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function checked(value: unknown, expected: ReturnType<typeof prepare>): CustomCohortGroupMarketResponse {
  const identity = JSON.stringify(expected);
  if (value && typeof value === 'object' && receipts.has(value)) {
    requireThat(receipts.get(value) === identity); return value as CustomCohortGroupMarketResponse;
  }
  const v = own(detached(value), ['subject', 'analyses', 'recommendation', 'unavailable_areas', 'independence_notice',
    'exploration_binding', 'exploration_selection_ref']);
  const response = v as unknown as CustomCohortGroupMarketResponse;
  const binding = own(v.exploration_binding, ['context_ref', 'selection_revision', 'selection_sha256']);
  const ref = prepareCustomCohortGroupSelectionReference(v.exploration_selection_ref);
  requireThat(response.subject?.account_id === expected.accountId && same(ref, expected.selectionRef)
    && same(binding.context_ref, expected.contextRef) && binding.selection_revision === ref.selection_revision
    && binding.selection_sha256 === ref.selection_sha256 && Array.isArray(response.analyses) && response.analyses.length === 1
    && Array.isArray(response.unavailable_areas) && response.unavailable_areas.length === 0
    && response.recommendation && typeof response.recommendation === 'object' && !Array.isArray(response.recommendation)
    && typeof response.independence_notice === 'string');
  const analysis = response.analyses[0], date = new Date(`${expected.asOf}T00:00:00.000Z`);
  const partial = date.getUTCDate() !== new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const end = partial ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)) : date;
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - expected.periodMonths + 1, 1));
  requireThat(analysis?.market?.key === 'exploration' && analysis.market.scope === 'exploration'
    && analysis.period?.start === start.toISOString().slice(0, 10) && analysis.period.end === end.toISOString().slice(0, 10)
    && analysis.filters?.analysis_as_of === expected.asOf && analysis.filters.period_months === expected.periodMonths
    && analysis.filters.record_type === 'closed_sale' && analysis.filters.complete_calendar_months === true
    && analysis.filters.partial_as_of_month_excluded === partial
    && Number.isSafeInteger(analysis.population?.eligible_sale_count) && analysis.population.eligible_sale_count >= 0
    && Number.isSafeInteger(analysis.population.mapped_sale_count) && analysis.population.mapped_sale_count >= 0
    && analysis.population.mapped_sale_count <= analysis.population.eligible_sale_count);
  const result = Object.freeze({ ...response, exploration_selection_ref: ref });
  receipts.set(result, identity); return result;
}

/** An injected view port must obey the same response binding as the real wire.
 * This validates data only and cannot create a display or server capability. */
export function checkCustomCohortGroupMarketResponse(value: unknown, expected: CustomCohortGroupMarketInput) {
  return checked(value, prepare(expected));
}

/** One authenticated, no-store request with the caller's signal. Only the exact
 * original reference travels; no member array, geometry, cache, retry, timer,
 * report write or Apply permission is introduced. Current rights stay server-owned. */
export function createCustomCohortGroupMarketTransport(options: Parameters<typeof createCustomCohortJsonTransport>[0]) {
  const post = createCustomCohortJsonTransport(options);
  return async (value: CustomCohortGroupMarketInput, io: { signal: AbortSignal }): Promise<CustomCohortGroupMarketResponse> => {
    const pinned = prepare(value);
    return checked(await post(pinned.accountId, 'selection-market-analysis', { assignment_file_id: pinned.assignmentFileId,
      context_ref: pinned.contextRef, selection_ref: pinned.selectionRef, area_keys: ['exploration'],
      as_of: pinned.asOf, period_months: pinned.periodMonths, context_override: pinned.contextOverride }, io), pinned);
  };
}
