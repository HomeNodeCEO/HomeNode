import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { CACHED_ROW_PROJECTION_FIELDS, mapCachedParcelRow, mapCachedAccountRow,
  mapCachedSaleRow, mapCachedSaleLinkRow } from './cachedRowMappings.js';

export const CACHED_CAD_EVIDENCE_MAPPING_VERSION = 4;
export const CACHED_CAD_EVIDENCE_FIELDS = Object.freeze([
  'class_code', 'class_description', 'use_description', 'structure_type', 'built_up',
]);
export const CACHED_CAD_EVIDENCE_LIMITS = Object.freeze({
  text_utf8_bytes: 4096, row_utf8_bytes: 1_000_000, nodes: 100_000, depth: 40,
});
const L = CACHED_CAD_EVIDENCE_LIMITS;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function fail(reason) {
  throw Object.assign(new TypeError(`invalid_neighborhood_cached_cad_evidence_row:${reason}`), {
    code: 'NEIGHBORHOOD_CACHED_CAD_EVIDENCE_ROW_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }

// The old mappers remain untouched. Admit their selected data properties before
// invoking them. Private/unknown properties are never evaluated or traversed.
function projection(input, kind) {
  check(input && typeof input === 'object' && !isProxy(input)
    && Object.getPrototypeOf(input) === Object.prototype, 'projection_object');
  const keys = Reflect.ownKeys(input); check(keys.length <= L.nodes, 'projection_limit');
  const baseKeys = new Set(CACHED_ROW_PROJECTION_FIELDS[kind]), baseEntries = [], extras = {};
  let unretained = false;
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    const extra = kind === 'parcel' && CACHED_CAD_EVIDENCE_FIELDS.includes(key);
    if (!baseKeys.has(key) && !extra) { if (typeof key === 'string' && d.enumerable) unretained = true; continue; }
    check(d.enumerable && Object.hasOwn(d, 'value') && d.value !== undefined, 'data_properties_required');
    if (extra) extras[key] = d.value; else baseEntries.push([key, d.value]);
  }
  const base = Object.fromEntries(baseEntries), stack = [[base, 0, false]], ancestors = new Set();
  let nodes = 0, bytes = 0;
  const text = value => { bytes += Buffer.byteLength(value); check(bytes <= L.row_utf8_bytes, 'projection_limit'); };
  while (stack.length) {
    const [value, depth, leaving] = stack.pop();
    if (leaving) { ancestors.delete(value); continue; }
    check(++nodes <= L.nodes && depth <= L.depth, 'projection_limit');
    if (typeof value === 'string') { text(value); continue; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) continue;
    check(value && typeof value === 'object' && !isProxy(value), 'plain_data_required');
    const array = Array.isArray(value), own = Reflect.ownKeys(value);
    check(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype)
      && !ancestors.has(value) && (!array || own.length === value.length + 1), 'plain_data_required');
    check(nodes + stack.length + own.length <= L.nodes, 'projection_limit');
    ancestors.add(value); stack.push([value, depth, true]);
    for (const key of own) {
      if (array && key === 'length') continue;
      check(typeof key === 'string' && (!array || (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)), 'plain_data_required');
      const d = Object.getOwnPropertyDescriptor(value, key);
      check(d.enumerable && Object.hasOwn(d, 'value'), 'plain_data_required');
      text(key); stack.push([d.value, depth + 1, false]);
    }
  }
  return { base, extras, unretained };
}
function map(input, kind, mapper) {
  const selected = projection(input, kind), original = mapper(selected.base), raw = { ...original.raw_projection };
  if (kind === 'parcel') {
    check(CACHED_CAD_EVIDENCE_FIELDS.every(key => Object.hasOwn(selected.extras, key)), 'cad_fields_required');
    for (const key of CACHED_CAD_EVIDENCE_FIELDS) {
      const value = selected.extras[key];
      check(value === null || (key === 'built_up' ? typeof value === 'boolean'
        : typeof value === 'string' && value.isWellFormed() && !value.includes('\u0000')
          && Buffer.byteLength(value) <= L.text_utf8_bytes), key);
      raw[key] = value; // Stored literal observation: no trimming/default/code interpretation.
    }
  }
  const canonical = canonicalAssessmentJson(raw);
  check(Buffer.byteLength(canonical) <= L.row_utf8_bytes, 'projection_limit');
  assertNeighborhoodJsonbStorage(raw);
  const gaps = new Set(original.capability_gaps);
  if (selected.unretained) gaps.add('projection_fields_not_retained');
  return freeze({ record_id: original.record_id, data: { ...original.data,
    cached_mapping_version: CACHED_CAD_EVIDENCE_MAPPING_VERSION,
    cached_projection_sha256: assessmentEvidenceDigest({ mapping_version: CACHED_CAD_EVIDENCE_MAPPING_VERSION,
      projection_kind: kind, raw_projection: raw }) }, raw_projection: raw, capability_gaps: [...gaps].sort() });
}

/** Additive current-mirror evidence only. Four text columns are stored import
 * observations; built_up is a stored LOCAL derived boolean, not provider proof
 * of a completed home. All normalized v2 data/capability gaps stay unchanged.
 * Mapping4 does not contain mapping3 MLS witnesses, infer detached housing,
 * establish history/eligibility, or change the default source reader.
 */
export const mapCadEvidenceParcelRow = input => map(input, 'parcel', mapCachedParcelRow);
export const mapCadEvidenceAccountRow = input => map(input, 'account', mapCachedAccountRow);
export const mapCadEvidenceSaleRow = input => map(input, 'sale', mapCachedSaleRow);
export const mapCadEvidenceSaleLinkRow = input => map(input, 'sale_link', mapCachedSaleLinkRow);
