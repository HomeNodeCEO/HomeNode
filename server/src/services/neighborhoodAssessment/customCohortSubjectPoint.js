import { canonicalAssessmentJson } from './contract.js';
import { decodeNeighborhoodOriginalValue } from './originalValueDecoding.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const DECIMAL = /^-?(?:0|[1-9]\d{0,2})(?:\.\d{0,14}[1-9])?$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function coordinate(value, bound) {
  // Do not round to fit the selector, coerce null to zero, swap axes or use
  // an address/geocoder fallback. Original snapshot representation is retained.
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)
      || Math.abs(value) > bound) return null;
  const text = String(value);
  return DECIMAL.test(text) ? text : null;
}
function timestamp(value) {
  const decoded = decodeNeighborhoodOriginalValue('timestamptz', 'present', value);
  if (decoded.status === 'decoded') return decoded.value;
  // Original row text uses the PostgreSQL session's timezone. Interpret its
  // explicit offset without changing the retained bytes or losing microseconds.
  if (typeof value !== 'string') return null;
  const offset = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!offset) return null;
  const hours = Number(offset[5]), minutes = Number(offset[6] ?? '0');
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const local = decodeNeighborhoodOriginalValue('timestamptz', 'present',
    `${offset[1]}T${offset[2]}.${(offset[3] ?? '').padEnd(6, '0')}Z`);
  if (local.status !== 'decoded') return null;
  const offsetMinutes = (hours * 60 + minutes) * (offset[4] === '+' ? 1 : -1);
  const shifted = new Date(new Date(local.value).getTime() - offsetMinutes * 60_000).toISOString();
  const utc = decodeNeighborhoodOriginalValue('utc6', 'present', `${shifted.slice(0, 23)}${local.value.slice(23, 26)}Z`);
  return utc.status === 'decoded' ? utc.value : null;
}
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

/** Internal representation adapter for createCustomCohortSubjectRepository.load.
 * The repository, not this pure function, verifies tenant/file identity and the
 * original immutable blobs. A represented recorded centroid is NOT an access
 * capability, current-source admission, or a native provider-geometry proof.
 * Never expose this helper as an HTTP coordinate/authority validation service.
 */
export function representCustomCohortSubjectPoint(retained) {
  const base = { point_version: 1, authority: 'not_established',
    provenance: 'retained_recorded_dcad_centroid', provider_geometry_verified: false };
  const unavailable = reason => frozen({ ...base, status: 'review_required', reason, geometry_input: null });
  if (!object(retained) || retained.subject_input_version !== 1
      || retained.usage !== 'retained_subject_inputs_only' || !object(retained.target)
      || retained.target.workflow_type !== 'custom_appraisal') return unavailable('retained_subject_required');
  let reference;
  try {
    reference = prepareNeighborhoodCohortBlobReference(retained.original_snapshot_row?.content_sha256,
      retained.original_snapshot_row?.canonical_utf8_bytes);
  } catch { return unavailable('original_snapshot_reference_required'); }
  const raw = decodeNeighborhoodOriginalValue('jsonb', 'present', retained.original_snapshot?.pg_row_json);
  if (raw.status !== 'decoded' || !object(raw.value)) return unavailable('original_snapshot_unrepresented');
  const row = raw.value;
  const target = retained.target;
  if (row.id !== target.subject_snapshot_id || row.appraisal_case_id !== target.appraisal_case_id
      || row.snapshot_version !== target.snapshot_version) return unavailable('snapshot_identity_mismatch');
  const data = decodeNeighborhoodOriginalValue('jsonb', row.subject_data?.state, row.subject_data?.pg_text);
  if (data.status !== 'decoded' || !object(data.value)) return unavailable('subject_data_unrepresented');
  // load() has already checked this equality against the original retained
  // evidence; keep it explicit here so a caller cannot pair two representations.
  if (!object(retained.snapshot?.subject_data)
      || canonicalAssessmentJson(data.value) !== canonicalAssessmentJson(retained.snapshot.subject_data)) {
    return unavailable('subject_evidence_mismatch');
  }
  const property = data.value.custom_property_snapshot;
  const location = property?.location;
  if (!object(property) || !object(location)) return unavailable('recorded_location_missing');
  if (typeof target.account_id !== 'string' || !target.account_id
      || property.account?.account_id !== target.account_id || location.account_id !== target.account_id) {
    return unavailable('account_identity_mismatch');
  }
  if (location.source !== 'dcad_parcel_query' || location.precision !== 'parcel_centroid') {
    return unavailable('recorded_source_unsupported');
  }
  if (location.status !== 'matched' || location.review_required !== false
      || location.review_reason !== null || location.confidence !== 'high') {
    return unavailable('recorded_location_needs_review');
  }
  if (location.match_method !== 'parcel_id' || location.source_parcel_id !== target.account_id
      || location.feature_count !== 1 || location.metadata?.address_agreement !== true) {
    return unavailable('recorded_parcel_match_ambiguous');
  }
  const longitude = coordinate(location.longitude, 180), latitude = coordinate(location.latitude, 90);
  if (longitude === null || latitude === null) return unavailable('coordinate_representation_unsupported');
  const capturedAt = timestamp(row.created_at), geocodedAt = timestamp(location.geocoded_at);
  const sourceUpdatedAt = location.source_updated_at === null ? null : timestamp(location.source_updated_at);
  if (!capturedAt || !geocodedAt || (location.source_updated_at !== null && !sourceUpdatedAt)) {
    return unavailable('recorded_chronology_unrepresented');
  }
  if (geocodedAt > capturedAt || (sourceUpdatedAt && sourceUpdatedAt > geocodedAt)) {
    return unavailable('recorded_chronology_inconsistent');
  }
  // The digest names the ORIGINAL row wrapper retained by the repository, not
  // invented provider rings or a newly fetched mutable location row.
  return frozen({ ...base, status: 'represented', reason: null,
    target: { ...target }, original_snapshot_row: reference,
    recorded_at: { snapshot_created_at: capturedAt, geocoded_at: geocodedAt, source_updated_at: sourceUpdatedAt },
    geometry_input: { geometry_version: 1, type: 'Point', crs: 'EPSG:4326',
      axis_order: 'longitude_latitude', coordinate_encoding: 'decimal_string_v1',
      coordinates: [longitude, latitude], source_sha256: reference.content_sha256 } });
}
