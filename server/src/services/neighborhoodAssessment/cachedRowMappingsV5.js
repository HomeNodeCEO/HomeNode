import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { CACHED_CAD_EVIDENCE_LIMITS, mapCadEvidenceParcelRow, mapCadEvidenceAccountRow,
  mapCadEvidenceSaleRow, mapCadEvidenceSaleLinkRow, hasOriginalPrimitiveCadMappingReceipt } from './cachedRowMappingsV4.js';
import { prepareCachedSaleWitnessV2 } from './cachedSaleWitnessV2.js';

export const CACHED_COMBINED_EVIDENCE_MAPPING_VERSION = 5;
const SOURCE_FIELDS = Object.freeze(['source_mls_status', 'source_row_number', 'source_raw_witness']);
const ORIGINAL_PRIMITIVE_MAPPINGS = new WeakMap();
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`invalid_neighborhood_cached_combined_evidence_row:${reason}`), {
    code: 'NEIGHBORHOOD_CACHED_COMBINED_EVIDENCE_ROW_INVALID', reason,
  });
}

// Reuse the unchanged CAD4 admission/mapping for every base observation. Only
// split the three installed sale cells here; copy descriptors, not values, so
// unknown private getters/proxies remain unvisited and retain their gap flag.
function splitSale(input) {
  check(input && typeof input === 'object' && !isProxy(input)
    && Object.getPrototypeOf(input) === Object.prototype, 'projection_object');
  const keys = Reflect.ownKeys(input), base = {}, extras = {};
  check(keys.length <= CACHED_CAD_EVIDENCE_LIMITS.nodes, 'projection_limit');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!SOURCE_FIELDS.includes(key)) { Object.defineProperty(base, key, descriptor); continue; }
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      && descriptor.value !== undefined, 'data_properties_required');
    extras[key] = descriptor.value;
  }
  return { base, extras };
}

function map(input, kind, mapper) {
  const selected = kind === 'sale' ? splitSale(input) : null;
  const original = mapper(selected ? selected.base : input);
  let raw = original.raw_projection;
  if (selected) {
    const { extras } = selected;
    if (original.data.source_record_id === null) {
      check(Object.keys(extras).length === 0, 'legacy_source_witness');
    } else {
      check(SOURCE_FIELDS.every(key => Object.hasOwn(extras, key)), 'source_witness_fields_required');
      const status = extras.source_mls_status, number = extras.source_row_number;
      check(status === null || (typeof status === 'string' && status.isWellFormed()
        && !status.includes('\u0000') && Buffer.byteLength(status) <= 512), 'source_mls_status');
      check(number === null || (Number.isInteger(number) && !Object.is(number, -0)
        && number >= -2_147_483_648 && number <= 2_147_483_647), 'source_row_number');
      raw = Object.freeze({ ...raw, source_mls_status: status, source_row_number: number,
        source_raw_witness: prepareCachedSaleWitnessV2(extras.source_raw_witness) });
      check(Buffer.byteLength(canonicalAssessmentJson(raw)) <= CACHED_CAD_EVIDENCE_LIMITS.row_utf8_bytes, 'projection_limit');
      assertNeighborhoodJsonbStorage(raw);
    }
  }
  const result = Object.freeze({ record_id: original.record_id, data: Object.freeze({ ...original.data,
    cached_mapping_version: CACHED_COMBINED_EVIDENCE_MAPPING_VERSION,
    cached_projection_sha256: assessmentEvidenceDigest({ mapping_version: CACHED_COMBINED_EVIDENCE_MAPPING_VERSION,
      projection_kind: kind, raw_projection: raw }) }), raw_projection: raw, capability_gaps: original.capability_gaps });
  if (hasOriginalPrimitiveCadMappingReceipt(original, kind, 4)) ORIGINAL_PRIMITIVE_MAPPINGS.set(result, kind);
  return result;
}

// Exact immutable mapper identity only: never an acquisition, retention or
// authorization receipt. Copies and reopened graphs must be remapped normally.
export function hasOriginalPrimitiveCombinedMappingReceipt(wrapper, kind, mappingVersion) {
  return mappingVersion === CACHED_COMBINED_EVIDENCE_MAPPING_VERSION
    && (kind === 'parcel' || kind === 'account') && ORIGINAL_PRIMITIVE_MAPPINGS.get(wrapper) === kind;
}

/** Dormant literal preservation, not source meaning. CAD4 and typed observations
 * are unchanged; witness2 belongs to its own current source payload. It does not
 * establish currency/area units, repair surviving typed values or make a sale
 * eligible. Old versions and their content hashes remain exactly unchanged. */
export const mapCombinedEvidenceParcelRow = input => map(input, 'parcel', mapCadEvidenceParcelRow);
export const mapCombinedEvidenceAccountRow = input => map(input, 'account', mapCadEvidenceAccountRow);
export const mapCombinedEvidenceSaleRow = input => map(input, 'sale', mapCadEvidenceSaleRow);
export const mapCombinedEvidenceSaleLinkRow = input => map(input, 'sale_link', mapCadEvidenceSaleLinkRow);
