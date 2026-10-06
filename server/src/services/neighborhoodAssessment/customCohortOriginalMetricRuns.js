import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { customCohortObservationMemberReader, isIssuedCustomCohortIndexedObservationPreview,
  verifyCustomCohortObservationMetricCell,
  CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { customCohortPreviewBinding } from './customCohortPreviewPresentation.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { createExactPagedObservationRunStore, EXACT_PAGED_OBSERVATION_RUN_LIMITS } from './exactPagedObservationRuns.js';
import { prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { CUSTOM_COHORT_CAPTURE_INPUT_LIMITS } from './customCohortCaptureInputs.js';

const issued = new WeakMap();
const KINDS = Object.freeze({ stock: ['year_built', 'gla_sqft', 'site_area_sqft', 'assessed_value'],
  transactions: ['recorded_total_price'], source_reported: ['living_area', 'lot_size_area', 'year_built',
    'bedrooms_total', 'bathrooms_total_integer', 'bathrooms_full', 'bathrooms_half', 'garage_spaces',
    'days_on_market', 'current_price'] });
const IDS = Object.freeze({ stock: 'account_id', transactions: 'canonical_transaction_id', source_reported: 'source_record_id' });
const L = Object.freeze({ row_bytes: 128000, original_bytes: CUSTOM_COHORT_CAPTURE_INPUT_LIMITS.logical_utf8_bytes,
  measurements: CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS.measurement_work,
  members: CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS.member_work,
  operations: EXACT_PAGED_OBSERVATION_RUN_LIMITS.blob_operations,
  staged_blobs: CUSTOM_COHORT_CAPTURE_INPUT_LIMITS.blobs,
  staged_bytes: EXACT_PAGED_OBSERVATION_RUN_LIMITS.staged_bytes });
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_original_metric_${reason}`),
  { code: 'CUSTOM_COHORT_ORIGINAL_METRIC_INVALID', state: 'incomplete', reason }); }
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function options({ signal, checkBudget = () => {} } = {}) {
  if (typeof checkBudget !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) fail('options');
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget(); if (signal?.aborted) fail('cancelled'); };
  return { signal, checkBudget: check, check };
}
function data(value, keys) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('shape');
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('shape');
    result[key] = d.value;
  }
  return result;
}
function sourceOf(value) { const source = issued.get(value); if (!source) fail('issued_source_required'); return source; }
function cellValue(cell) {
  const value = cell?.value;
  if (!cell || !['observed', 'missing', 'invalid', 'conflicting'].includes(cell.state)
    || (cell.state === 'observed' ? typeof value !== 'number' || !Number.isFinite(value) : value !== null)
    || (cell.state === 'observed' ? typeof cell.exact_value !== 'string' : cell.exact_value !== null)
    || !Array.isArray(cell.raw_values)
    || !['observed_record_count', 'missing_record_count', 'invalid_record_count'].every(key =>
      Number.isSafeInteger(cell[key]) && cell[key] >= 0)) fail('cell');
  return value;
}

/** Compile one COMPLETE selected population/metric from an issued, freshly
 * original-verified immutable observation preview. No request supplies member
 * cells, units, period, provenance, prices or table ordinals. Canonical sale IDs
 * remain transactions; source-record rows remain all-date observations. Null
 * reasons, decimal/conflict witnesses and whole package prices are retained.
 *
 * This receipt proves only this in-process projection. The caller MUST own the
 * exact original context/catalog/current selection verification, current source
 * and assignment rights, transaction/deadline and final publication fences.
 * It is not source admission, historical applicability or statistical reliability.
 * No live owner/calculator/cap/cache/schema is switched by this module.
 */
export async function prepareCustomCohortOriginalMetricSource(input, operationOptions = {}) {
  const { preview, selectionRef, kind, metric } = data(input, ['preview', 'selectionRef', 'kind', 'metric']);
  const op = options(operationOptions); op.check();
  if (!isIssuedCustomCohortIndexedObservationPreview(preview) || !KINDS[kind]?.includes(metric)) fail('source');
  const copiedRef = data(selectionRef, ['selection_version', 'selection_revision', 'selection_sha256', 'manifest_ref']);
  copiedRef.manifest_ref = data(copiedRef.manifest_ref, ['content_sha256', 'canonical_utf8_bytes']);
  const reference = prepareCustomCohortGroupSelectionReference(copiedRef);
  const binding = customCohortPreviewBinding(preview,
    { context_ref: preview.context_ref, selection_revision: reference.selection_revision });
  if (binding.selection_sha256 !== reference.selection_sha256) fail('selection_mismatch');
  const population = preview.selected, originalMetric = population[kind].metrics[metric];
  if (!originalMetric || originalMetric.currency !== null || originalMetric.interpretation !== 'captured_observations_only'
    || originalMetric.denominator_basis !== 'population_members'
    || originalMetric.cod_interpretation !== 'descriptive_dispersion_not_reliability') fail('semantics');
  const reader = customCohortObservationMemberReader(preview, population, kind);
  if (reader.member_count !== population[kind].member_count) fail('member_count');
  const getCell = row => kind === 'transactions' ? row.recorded_total_price : row.observations[metric];
  const counts = { conflicting_count: 0, invalid_count: 0, absent_count: 0, partially_observed_count: 0 };
  const witness = createHash('sha256').update('[', 'utf8'); let prior = null, bytes = 0, members = 0;
  for (let ordinal = 0; ordinal < reader.member_count; ordinal++) {
    op.check(); const row = reader.at(ordinal), id = row[IDS[kind]], cell = getCell(row); cellValue(cell);
    verifyCustomCohortObservationMetricCell(cell, kind, metric);
    if (typeof id !== 'string' || !id || (prior !== null && id <= prior)) fail('member_identity'); prior = id;
    if (!Array.isArray(row.source_references)) fail('provenance');
    members += 1 + row.source_references.length + (row.associated_account_ids?.length ?? 0);
    if (members > L.members || ordinal + 1 > L.measurements) fail('work_limit');
    // A full original member (not just its Number) witnesses identity, decimal
    // disagreements, links, package/date dispositions, raw values and provenance.
    // Only one bounded row string is retained while hashing the complete order.
    const text = json(row), length = Buffer.byteLength(text); bytes += length;
    if (length > L.row_bytes || bytes > L.original_bytes) fail('original_bytes_limit');
    witness.update(`${ordinal ? ',' : ''}${text}`, 'utf8');
    if (cell.state === 'missing') counts.absent_count++;
    else if (cell.state === 'conflicting') counts.conflicting_count++;
    else if (cell.state === 'invalid') counts.invalid_count++;
    else if (cell.missing_record_count > 0) counts.partially_observed_count++;
    if ((ordinal + 1) % 125 === 0) { await yieldToRequests(); op.check(); }
  }
  const metadata = { source_version: 1, context_ref: binding.context_ref, selection_ref: reference,
    target: preview.target, effective_date: preview.effective_date, observation_period: preview.observation_period,
    captured_at: preview.captured_at, population_id: population.id,
    account_set_sha256: hash(json(population.account_ids)), kind, metric, member_count: reader.member_count,
    ordered_member_original_sha256: witness.update(']', 'utf8').digest('hex'),
    definition: population[kind].definition, member_unit: population[kind].member_unit,
    temporal_basis: population[kind].temporal_basis ?? population[kind].observation_period,
    label: originalMetric.label, unit: originalMetric.unit, currency: null,
    interpretation: 'captured_observations_only', denominator_basis: 'population_members',
    cod_interpretation: 'descriptive_dispersion_not_reliability', ...counts };
  const bindingJson = json(metadata);
  if (Buffer.byteLength(bindingJson) > EXACT_PAGED_OBSERVATION_RUN_LIMITS.binding_bytes) fail('binding_limit');
  const valueAtOrdinal = ordinal => cellValue(getCell(reader.at(ordinal)));
  const receipt = Object.freeze({ source_version: 1, authority: 'not_established', binding_json: bindingJson,
    member_count: reader.member_count });
  issued.set(receipt, { bindingJson, member_count: reader.member_count, counts: Object.freeze(counts),
    originalMetric, originalBytes: bytes, memberWork: members, valueAtOrdinal,
    pages: function* () {
      for (let start = 0; start < reader.member_count; start += EXACT_PAGED_OBSERVATION_RUN_LIMITS.page_values) {
        const page = [];
        for (let ordinal = start; ordinal < Math.min(reader.member_count, start + EXACT_PAGED_OBSERVATION_RUN_LIMITS.page_values); ordinal++) {
          page.push(valueAtOrdinal(ordinal));
        }
        yield Object.freeze(page);
      }
    } });
  op.check(); return receipt;
}

/** Transaction-local original-bound numerical owner. Reopening takes a NEW
 * source receipt compiled from currently authorized originals, not a receipt
 * serialized in a job/browser or an old source-rights decision. Aggregate all
 * metrics/intermediate puts/reads in this one owner; caller registers every
 * returned retention root with its versioned graph or rolls back the whole TX.
 * No root registration, report update, BEGIN/COMMIT or current-head mutation.
 */
export function createCustomCohortOriginalMetricRunOwner(blobs, operationOptions = {}) {
  if (!blobs || isProxy(blobs) || typeof blobs.put !== 'function' || typeof blobs.get !== 'function') fail('repository');
  const put = blobs.put.bind(blobs), get = blobs.get.bind(blobs), op = options(operationOptions);
  let calls = 0, stagedBytes = 0, readBytes = 0, measurements = 0, memberWork = 0, sourceBytes = 0;
  const retained = new Map();
  const port = () => { op.check(); if (++calls > L.operations) fail('operations_limit'); };
  const store = createExactPagedObservationRunStore({
    async put(text) {
      port(); const r = await put(text); op.check();
      const ref = data(r, ['content_sha256', 'canonical_utf8_bytes']); blobRef(ref.content_sha256, ref.canonical_utf8_bytes);
      if (ref.content_sha256 !== hash(text) || ref.canonical_utf8_bytes !== String(Buffer.byteLength(text))) fail('storage_ack');
      if (!retained.has(ref.content_sha256)) {
        retained.set(ref.content_sha256, Object.freeze(ref)); stagedBytes += Number(ref.canonical_utf8_bytes);
        if (retained.size > L.staged_blobs || stagedBytes > L.staged_bytes) fail('stage_limit');
      }
      return ref;
    },
    async get(hash, bytes) {
      port(); readBytes += Number(bytes);
      if (readBytes > L.original_bytes) fail('read_limit');
      const text = await get(hash, bytes); op.check(); return text;
    },
  });
  const charge = source => {
    measurements += source.member_count; memberWork += source.memberWork; sourceBytes += source.originalBytes;
    if (measurements > L.measurements || memberWork > L.members || sourceBytes > L.original_bytes) fail('work_limit');
  };
  return Object.freeze({
    async stage(sourceReceipt) {
      const source = sourceOf(sourceReceipt); op.check(); charge(source);
      const staged = await store.stage({ ...source, signal: op.signal, checkBudget: op.check }); op.check();
      return Object.freeze({ authority: 'not_established', manifest_ref: staged.manifest_ref,
        // Includes ALL intermediate runs, not only the final distribution root.
        retention_refs: Object.freeze([...retained.values()]) });
    },
    async distribution(sourceReceipt, manifestRef, { minimum_count = 1 } = {}) {
      const source = sourceOf(sourceReceipt); op.check(); charge(source);
      const result = await store.distributionFromOriginalPages({ ...source, manifestRef, minimum_count,
        signal: op.signal, checkBudget: op.check }); op.check();
      const original = source.originalMetric;
      return Object.freeze({ label: original.label, unit: original.unit, currency: null,
        interpretation: 'captured_observations_only', denominator_basis: 'population_members', ...result,
        ...source.counts, cod_interpretation: 'descriptive_dispersion_not_reliability' });
    },
  });
}
