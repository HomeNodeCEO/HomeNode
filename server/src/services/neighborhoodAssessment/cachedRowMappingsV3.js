import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { CACHED_ROW_PROJECTION_FIELDS, mapCachedParcelRow, mapCachedAccountRow,
  mapCachedSaleRow, mapCachedSaleLinkRow } from './cachedRowMappings.js';
import { prepareCachedSaleWitness } from './cachedSaleWitness.js';

export const CACHED_WITNESS_MAPPING_VERSION = 3;
const SALE_WITNESS_FIELDS = ['source_mls_status', 'source_row_number', 'source_raw_witness'];
const MAX_ROW_BYTES = 1_000_000, MAX_NODES = 100_000, MAX_DEPTH = 40;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function fail(reason) {
  throw Object.assign(new TypeError(`invalid_neighborhood_cached_witness_row:${reason}`), {
    code: 'NEIGHBORHOOD_CACHED_WITNESS_ROW_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }

// v2 intentionally remains byte-identical. Before calling it, admit only its
// selected data properties without invoking getters, proxies or toJSON. Unknown
// private columns are not traversed/copied, even if they contain hostile values.
function selectedProjection(input, kind) {
  check(input && typeof input === 'object' && !isProxy(input)
    && Object.getPrototypeOf(input) === Object.prototype, 'projection_object');
  const keys = Reflect.ownKeys(input);
  check(keys.length <= MAX_NODES, 'projection_limit');
  const installed = new Set([...CACHED_ROW_PROJECTION_FIELDS[kind], ...(kind === 'sale' ? SALE_WITNESS_FIELDS : [])]);
  const baseEntries = [], extras = {};
  let unretained = false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!installed.has(key)) { if (typeof key === 'string' && descriptor.enumerable) unretained = true; continue; }
    check(Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined, 'data_properties_required');
    if (kind === 'sale' && SALE_WITNESS_FIELDS.includes(key)) extras[key] = descriptor.value;
    else baseEntries.push([key, descriptor.value]);
  }
  const base = Object.fromEntries(baseEntries), path = new Set();
  let nodes = 0, textBytes = 0;
  const text = value => { textBytes += Buffer.byteLength(value); check(textBytes <= MAX_ROW_BYTES, 'projection_limit'); };
  function visit(value, depth) {
    check(++nodes <= MAX_NODES && depth <= MAX_DEPTH, 'projection_limit');
    if (typeof value === 'string') { text(value); return; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    check(value && typeof value === 'object' && !isProxy(value), 'plain_data_required');
    const array = Array.isArray(value);
    check(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
      && !path.has(value), 'plain_data_required');
    const own = Reflect.ownKeys(value);
    check(own.length <= MAX_NODES && (!array || own.length === value.length + 1), 'plain_data_required');
    path.add(value);
    for (const key of own) {
      if (array && key === 'length') continue;
      check(typeof key === 'string', 'plain_data_required');
      if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, 'plain_data_required');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'plain_data_required');
      text(key); visit(descriptor.value, depth + 1);
    }
    path.delete(value);
  }
  visit(base, 0);
  return { base, extras, unretained };
}

function map(input, kind, mapper) {
  const selected = selectedProjection(input, kind), original = mapper(selected.base);
  const raw = { ...original.raw_projection };
  if (kind === 'sale') {
    if (original.data.source_record_id === null) {
      // Canonical legacy SQL has no source row: absence, not synthetic NULL
      // source cells or an invented witness. v2 retains source_record_unavailable.
      check(Object.keys(selected.extras).length === 0, 'legacy_source_witness');
    } else {
      check(SALE_WITNESS_FIELDS.every(key => Object.hasOwn(selected.extras, key)), 'source_witness_fields_required');
      const status = selected.extras.source_mls_status, number = selected.extras.source_row_number;
      check(status === null || (typeof status === 'string' && status.isWellFormed()
        && !status.includes('\u0000') && Buffer.byteLength(status) <= 512), 'source_mls_status');
      // This is the stored PostgreSQL integer, not an assertion that an original
      // CSV row exists. Do not coerce strings or reject observable zero/negative
      // stored integers merely because they are not useful provenance.
      check(number === null || (Number.isInteger(number) && !Object.is(number, -0)
        && number >= -2_147_483_648 && number <= 2_147_483_647), 'source_row_number');
      const witness = prepareCachedSaleWitness(selected.extras.source_raw_witness);
      Object.assign(raw, { source_mls_status: status, source_row_number: number, source_raw_witness: witness });
    }
  }
  const canonical = canonicalAssessmentJson(raw);
  check(Buffer.byteLength(canonical) <= MAX_ROW_BYTES, 'projection_limit');
  assertNeighborhoodJsonbStorage(raw);
  const gaps = new Set(original.capability_gaps);
  if (selected.unretained) gaps.add('projection_fields_not_retained');
  return freeze({ record_id: original.record_id, data: { ...original.data,
    cached_mapping_version: CACHED_WITNESS_MAPPING_VERSION,
    cached_projection_sha256: assessmentEvidenceDigest({ mapping_version: CACHED_WITNESS_MAPPING_VERSION,
      projection_kind: kind, raw_projection: raw }) },
  raw_projection: raw, capability_gaps: [...gaps].sort() });
}

/** Additive, opt-in v3 evidence wrappers only. The unchanged v2 mappers retain
 * their defaults and old replay bytes. Witnessed stored values are not provider
 * truth, original file authority, currency/area units, history or eligibility.
 */
export const mapWitnessParcelRow = input => map(input, 'parcel', mapCachedParcelRow);
export const mapWitnessAccountRow = input => map(input, 'account', mapCachedAccountRow);
export const mapWitnessSaleRow = input => map(input, 'sale', mapCachedSaleRow);
export const mapWitnessSaleLinkRow = input => map(input, 'sale_link', mapCachedSaleLinkRow);
