import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortOriginalMetricSource, createCustomCohortOriginalMetricRunOwner } from './customCohortOriginalMetricRuns.js';
import { EXACT_PAGED_OBSERVATION_RUN_LIMITS as R } from './exactPagedObservationRuns.js';
import { CUSTOM_COHORT_CAPTURE_INPUT_LIMITS as G } from './customCohortCaptureInputs.js';

const METRICS = Object.freeze([
  ...['year_built', 'gla_sqft', 'site_area_sqft', 'assessed_value'].map(metric => Object.freeze({ kind: 'stock', metric })),
  Object.freeze({ kind: 'transactions', metric: 'recorded_total_price' }),
  ...['living_area', 'lot_size_area', 'year_built', 'bedrooms_total', 'bathrooms_total_integer',
    'bathrooms_full', 'bathrooms_half', 'garage_spaces', 'days_on_market', 'current_price']
    .map(metric => Object.freeze({ kind: 'source_reported', metric })),
]);
const COMMON = ['source_version', 'context_ref', 'selection_ref', 'target', 'effective_date', 'observation_period',
  'captured_at', 'population_id', 'account_set_sha256'];
const ROOT_BYTES = 750000;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_complete_metric_${reason}`),
  { code: 'CUSTOM_COHORT_COMPLETE_METRIC_INVALID', state: 'incomplete', reason }); }
function closed(value, keys) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('shape');
  const copy = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('shape');
    copy[key] = d.value;
  }
  return copy;
}
function array(value, maximum) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) fail('array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail('array');
  return Array.from({ length: value.length }, (_, i) => {
    const d = descriptors[i];
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('array');
    return d.value;
  });
}
function reference(value, maximum = 1500000) {
  const r = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  const checked = blobRef(r.content_sha256, r.canonical_utf8_bytes);
  if (Number(checked.canonical_utf8_bytes) > maximum) fail('reference');
  return checked;
}
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};

/** One complete supplemental numeric group, not a context/selection registry.
 * The caller first authorizes and reopens the exact ORIGINAL indexed population
 * and current selection in its owned transaction. All fifteen distributions
 * complete together; missing/invalid/conflicting source cells retain their
 * existing meanings. No caller supplies cells, a metric subset or units.
 *
 * The immutable root names every final AND intermediate numeric original. The
 * caller must register this root WITH the original context/selection graph,
 * charge both graphs' aggregate budgets, and repeat current actor/assignment,
 * subject/source/private-review/head fences before COMMIT or delivery. Failure
 * requires rollback and discarding provisional results; this module neither
 * commits nor authorizes, publishes, caches, activates or raises installed caps.
 */
export function createCustomCohortCompleteMetricGroup(blobs, { signal, checkBudget = () => {} } = {}) {
  if (!blobs || isProxy(blobs) || typeof blobs.put !== 'function' || typeof blobs.get !== 'function'
    || typeof checkBudget !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) fail('dependencies');
  const put = blobs.put.bind(blobs), get = blobs.get.bind(blobs);
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget(); if (signal?.aborted) fail('cancelled'); };
  let calls = 0, readBytes = 0, stagedBytes = 0, busy = false, activeRoots = null;
  const retained = new Map();
  const exclusively = async work => {
    if (busy) fail('busy'); busy = true;
    try { return await work(); }
    finally { activeRoots = null; busy = false; }
  };
  const port = () => { check(); if (++calls > R.blob_operations) fail('operations_limit'); };
  const scoped = {
    async put(text) {
      const expected = blobRef(hash(text), String(Buffer.byteLength(text)));
      if (!retained.has(expected.content_sha256)
        && (retained.size + 1 > G.blobs || stagedBytes + Number(expected.canonical_utf8_bytes) > R.staged_bytes)) fail('stage_limit');
      port(); const actual = reference(await put(text)); check();
      if (json(actual) !== json(expected)) fail('storage_ack');
      if (!retained.has(actual.content_sha256)) {
        retained.set(actual.content_sha256, actual); stagedBytes += Number(actual.canonical_utf8_bytes);
      }
      activeRoots?.set(actual.content_sha256, actual);
      return actual;
    },
    async get(contentSha, bytes) {
      const r = blobRef(contentSha, bytes); port(); readBytes += Number(bytes);
      if (readBytes > G.logical_utf8_bytes) fail('read_limit');
      const text = await get(contentSha, bytes); check();
      if (typeof text !== 'string' || Buffer.byteLength(text) !== Number(bytes) || hash(text) !== r.content_sha256)
        fail('missing_or_changed_original');
      return text;
    },
  };
  const owner = createCustomCohortOriginalMetricRunOwner(scoped, { signal, checkBudget: check });
  async function sources(input) {
    const v = closed(input, ['preview', 'selectionRef']);
    // Capture the first immutable receipt/reference before the first await.
    const first = await prepareCustomCohortOriginalMetricSource({ ...v, ...METRICS[0] }, { signal, checkBudget: check });
    const firstBinding = JSON.parse(first.binding_json), binding = Object.fromEntries(COMMON.map(key => [key, firstBinding[key]]));
    const immutableInput = { preview: v.preview, selectionRef: binding.selection_ref }, result = [first];
    for (const descriptor of METRICS.slice(1)) {
      check(); const source = await prepareCustomCohortOriginalMetricSource({ ...immutableInput, ...descriptor }, { signal, checkBudget: check });
      const m = JSON.parse(source.binding_json);
      if (json(Object.fromEntries(COMMON.map(key => [key, m[key]]))) !== json(binding)) fail('source_binding');
      result.push(source);
    }
    check(); return { binding, result };
  }
  const roots = refs => {
    const list = array(refs, G.blobs - 1).map(r => reference(r)); let prior = '';
    for (const r of list) { if (r.content_sha256 <= prior) fail('retention_order'); prior = r.content_sha256; }
    if (!list.length) fail('retention_missing');
    return list;
  };
  function manifest(value, fresh) {
    const v = closed(value, ['metric_group_version', 'source_binding', 'metrics', 'retention_refs']);
    if (v.metric_group_version !== 1 || json(v.source_binding) !== json(fresh.binding)) fail('binding');
    const entries = array(v.metrics, METRICS.length);
    if (entries.length !== METRICS.length) fail('metric_count');
    const retention = roots(v.retention_refs), byHash = new Map(retention.map(r => [r.content_sha256, r]));
    const checked = entries.map((value, i) => {
      const entry = closed(value, ['kind', 'metric', 'binding_sha256', 'member_count', 'manifest_ref']);
      const source = fresh.result[i];
      if (entry.kind !== METRICS[i].kind || entry.metric !== METRICS[i].metric
        || entry.binding_sha256 !== hash(source.binding_json) || entry.member_count !== source.member_count) fail('metric_binding');
      const root = reference(entry.manifest_ref, R.manifest_bytes);
      if (json(byHash.get(root.content_sha256)) !== json(root)) fail('retention_missing');
      return { ...entry, manifest_ref: root };
    });
    return { entries: checked, retention };
  }
  return Object.freeze({
    async stage(input) {
      return exclusively(async () => {
        activeRoots = new Map();
        const fresh = await sources(input), entries = [];
        for (let i = 0; i < METRICS.length; i++) {
          check(); const staged = await owner.stage(fresh.result[i]);
          entries.push({ ...METRICS[i], binding_sha256: hash(fresh.result[i].binding_json),
            member_count: fresh.result[i].member_count, manifest_ref: staged.manifest_ref });
        }
        const retention = [...activeRoots.values()].sort((a, b) => a.content_sha256 < b.content_sha256 ? -1 : 1);
        const value = { metric_group_version: 1, source_binding: fresh.binding, metrics: entries, retention_refs: retention };
        manifest(value, fresh);
        const text = json(value); if (Buffer.byteLength(text) > ROOT_BYTES) fail('manifest_limit');
        const manifest_ref = await scoped.put(text); check();
        return frozen({ authority: 'not_established', manifest_ref,
          retention_refs: [...retention, manifest_ref].sort((a, b) => a.content_sha256 < b.content_sha256 ? -1 : 1) });
      });
    },
    async reopen(input, manifestRef) {
      return exclusively(async () => {
        // Copy/reject the navigation reference before asynchronous source work.
        const root = reference(manifestRef, ROOT_BYTES), fresh = await sources(input);
        const text = await scoped.get(root.content_sha256, root.canonical_utf8_bytes);
        let value; try { value = JSON.parse(text); if (json(value) !== text) fail('noncanonical'); }
        catch { fail('noncanonical'); }
        const { entries, retention } = manifest(value, fresh);
        if (retention.some(r => r.content_sha256 === root.content_sha256)) fail('retention_cycle');
        // Even unused intermediate merge originals must still exist. Verification
        // is fresh and bounded, never inferred from a cache or root hash alone.
        for (const r of retention) await scoped.get(r.content_sha256, r.canonical_utf8_bytes);
        const metrics = { stock: {}, transactions: {}, source_reported: {} };
        for (let i = 0; i < METRICS.length; i++) {
          check(); metrics[entries[i].kind][entries[i].metric] = await owner.distribution(fresh.result[i], entries[i].manifest_ref);
        }
        // A late root change or ending budget failure cannot return a prefix.
        if (await scoped.get(root.content_sha256, root.canonical_utf8_bytes) !== text) fail('manifest_changed');
        check();
        return frozen({ authority: 'not_established', context_ref: fresh.binding.context_ref,
          selection_ref: fresh.binding.selection_ref, metrics,
          retention_refs: [...retention, root].sort((a, b) => a.content_sha256 < b.content_sha256 ? -1 : 1) });
      });
    },
  });
}
