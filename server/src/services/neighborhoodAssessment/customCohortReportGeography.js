import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from './contract.js';

export const CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS = Object.freeze([
  'neighborhood_boundary_geometry', 'neighborhood_boundary_source', 'neighborhood_boundary_label',
  'neighborhood_boundary_north', 'neighborhood_boundary_east', 'neighborhood_boundary_south', 'neighborhood_boundary_west',
  'neighborhood_boundary_saved_at', 'neighborhood_boundary_confirmed', 'neighborhood_boundary_confirmed_at',
]);
export const CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS = Object.freeze({
  projected_utf8_bytes: 262144, rings: 1000, coordinates: 20000, oracle_text: 2000,
});
const L = CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS;
const MANUAL = 'appraiser_defined_area_manual_v2', CLEARED = 'appraiser_defined_area_cleared';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const PROJECTION = ['details_type', 'projected_utf8_bytes', 'projected_sha256', 'projected_json'];
const SIDES = ['north', 'east', 'south', 'west'];
const ADMISSIONS = new WeakMap(), COMPLETED = new WeakSet();
const emptyCardinals = () => Object.fromEntries(SIDES.map(side => [side, null]));
const sha = text => createHash('sha256').update(text).digest('hex');
const copy = value => JSON.parse(json(value));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_report_geography_${reason}`), {
    code: 'CUSTOM_COHORT_REPORT_GEOGRAPHY_INVALID', reason,
  });
}
function closed(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'input_shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable
    && Object.hasOwn(descriptors[key], 'value')), 'input_shape');
}
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'captured_at');
}
function plainText(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function targetOf(value) {
  closed(value, TARGET);
  check(typeof value.organization_id === 'string' && UUID.test(value.organization_id)
    && typeof value.report_file_id === 'string' && UUID.test(value.report_file_id)
    && typeof value.assignment_file_id === 'string' && /^[1-9][0-9]{0,18}$/.test(value.assignment_file_id)
    && BigInt(value.assignment_file_id) <= 9223372036854775807n
    && plainText(value.account_id, 100) && value.account_id.length > 0 && value.account_id === value.account_id.trim(), 'target');
  return copy(value);
}

// Structural representation admission only. No closure, snapping, winding,
// coordinate coercion or topology repair: the owner separately runs PostGIS.
function polygon(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2
    || value.type !== 'Polygon' || !Array.isArray(value.coordinates)) return { reason: 'geometry_shape' };
  if (!value.coordinates.length) return { reason: 'geometry_empty' };
  if (value.coordinates.length > L.rings) return { limit: true, reason: 'geometry_ring_limit' };
  const coordinates = []; let count = 0;
  for (const ring of value.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) return { reason: 'geometry_ring_shape' };
    if ((count += ring.length) > L.coordinates) return { limit: true, reason: 'geometry_coordinate_limit' };
    const points = [];
    for (const point of ring) {
      if (!Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v))
        || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return { reason: 'geometry_coordinate' };
      points.push([...point]);
    }
    if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) return { reason: 'geometry_ring_open' };
    if (new Set(points.slice(0, -1).map(p => `${p[0]},${p[1]}`)).size < 3) return { reason: 'geometry_ring_degenerate' };
    coordinates.push(points);
  }
  return { geometry: { type: 'Polygon', coordinates } };
}

/** Internal, pure admission of the owner's exact saved SQL projection. The
 * manual_v2 marker records new explicit editor drawing intent, not appraiser
 * licensure, independent source truth, historical applicability or authority.
 * Old manual_v1 has a known automatic-reset ambiguity and is not upgraded.
 */
export function prepareCustomCohortReportGeography(input) {
  closed(input, ['target', 'assignment_revision', 'projection', 'captured_at']);
  const target = targetOf(input.target); timestamp(input.captured_at);
  check(Number.isInteger(input.assignment_revision) && input.assignment_revision >= 1 && input.assignment_revision <= 2147483647, 'assignment_revision');
  closed(input.projection, PROJECTION);
  const p = input.projection;
  check(['sql_null', 'null', 'object', 'array', 'string', 'number', 'boolean'].includes(p.details_type), 'details_type');
  const binding = { target, assignment_revision: input.assignment_revision, captured_at: input.captured_at,
    details_type: p.details_type, projected_utf8_bytes: p.projected_utf8_bytes, projected_sha256: p.projected_sha256 };
  function result(status, reason, geometry = null, cardinals = emptyCardinals()) {
    const admission = freeze({ report_geography_version: 1, status, reason, binding, geometry_for_validation: geometry });
    ADMISSIONS.set(admission, { projection: copy(p), cardinals }); return admission;
  }
  if (p.details_type !== 'object') {
    check(p.projected_utf8_bytes === null && p.projected_sha256 === null && p.projected_json === null, 'projection_envelope');
    return ['sql_null', 'null'].includes(p.details_type)
      ? result('absent', `assignment_details_${p.details_type}`) : result('malformed', 'assignment_details_not_object');
  }
  check(Number.isSafeInteger(p.projected_utf8_bytes) && p.projected_utf8_bytes >= 2, 'projection_bytes');
  if (p.projected_utf8_bytes > L.projected_utf8_bytes) {
    check(p.projected_sha256 === null && p.projected_json === null, 'projection_limit_envelope');
    return result('limit_exceeded', 'saved_projection_byte_limit');
  }
  check(typeof p.projected_json === 'string' && Buffer.byteLength(p.projected_json) === p.projected_utf8_bytes
    && typeof p.projected_sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.projected_sha256)
    && sha(p.projected_json) === p.projected_sha256, 'projection_digest');
  let saved;
  try { saved = JSON.parse(p.projected_json); } catch { check(false, 'projection_json'); }
  check(saved && Object.getPrototypeOf(saved) === Object.prototype && !Array.isArray(saved), 'projection_json_object');
  check(Object.keys(saved).every(key => CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS.includes(key)), 'projection_fields');
  const lengths = { neighborhood_boundary_source: 200, neighborhood_boundary_label: 1000,
    neighborhood_boundary_saved_at: 100, neighborhood_boundary_confirmed_at: 100,
    ...Object.fromEntries(SIDES.map(side => [`neighborhood_boundary_${side}`, 500])) };
  for (const [key, max] of Object.entries(lengths)) {
    if (Object.hasOwn(saved, key) && saved[key] !== null && !plainText(saved[key], max)) return result('malformed', 'saved_field_type_or_limit');
  }
  if (Object.hasOwn(saved, 'neighborhood_boundary_confirmed') && saved.neighborhood_boundary_confirmed !== null
    && typeof saved.neighborhood_boundary_confirmed !== 'boolean') return result('malformed', 'saved_confirmation_type');
  const source = saved.neighborhood_boundary_source, geometry = saved.neighborhood_boundary_geometry;
  if (source === CLEARED) return geometry == null ? result('cleared', 'manual_geometry_cleared') : result('malformed', 'cleared_geometry_present');
  if (geometry == null) return source === MANUAL ? result('malformed', 'manual_geometry_missing') : result('absent', 'manual_geometry_absent');
  if (source !== MANUAL) return result('intent_unverified', source === 'appraiser_defined_area_manual_v1'
    ? 'legacy_manual_intent_unverified' : 'manual_intent_not_established');
  const admitted = polygon(geometry);
  if (!admitted.geometry) return result(admitted.limit ? 'limit_exceeded' : 'malformed', admitted.reason);
  // Unusable whitespace-only text stays absent. Do not manufacture a cardinal
  // label, or silently trim a nonempty literal that the core contract rejects.
  const cardinals = Object.fromEntries(SIDES.map(side => {
    const value = saved[`neighborhood_boundary_${side}`];
    return [side, typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null];
  }));
  return result('awaiting_topology', 'owner_topology_observation_required', admitted.geometry, cardinals);
}

/** The oracle is supplied ONLY by the internal owner after its parameterized
 * native query on this admission's exact geometry. A true result is topology,
 * not source applicability, named edges, containment or report readiness.
 */
export function completeCustomCohortReportGeography(admission, oracle) {
  check(ADMISSIONS.has(admission), 'admission_identity');
  const saved = ADMISSIONS.get(admission); let status = admission.status, reason = admission.reason, observation = null;
  if (status === 'awaiting_topology') {
    closed(oracle, ['is_valid', 'validation_reason', 'postgis_version']);
    check(typeof oracle.is_valid === 'boolean' && (oracle.validation_reason === null || plainText(oracle.validation_reason, L.oracle_text))
      && plainText(oracle.postgis_version, L.oracle_text) && oracle.postgis_version.trim().length > 0, 'oracle');
    observation = copy(oracle);
    status = oracle.is_valid ? 'manual_geometry_recorded' : 'invalid_topology';
    reason = oracle.is_valid ? 'manual_narrative_geometry_not_report_supported' : 'native_geometry_invalid';
  } else check(oracle === null, 'unexpected_oracle');
  const value = freeze({ report_geography_version: 1, status, reason, authority: 'not_established',
    basis: 'saved_editor_manual_narrative_geometry', binding: admission.binding, projection: saved.projection,
    geometry: status === 'manual_geometry_recorded' ? admission.geometry_for_validation : null,
    cardinal_summaries: status === 'manual_geometry_recorded' ? saved.cardinals : emptyCardinals(),
    oracle_observation: observation });
  COMPLETED.add(value); return value;
}

/** Called only by the real report preparation consumer. The module identity
 * prevents substituting an arbitrary JSON-shaped true oracle in this seam;
 * it does not authenticate the owner or upgrade any source/editor assertion.
 */
export function customCohortReportGeographyForAssessment(value, { target, binding }) {
  check(COMPLETED.has(value), 'completed_identity');
  const expected = { organization_id: target.scope.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: String(target.custom_assignment_file_id), account_id: target.scope.account_id };
  check(json(value.binding.target) === json(expected) && value.binding.captured_at <= binding.derived_at, 'report_binding');
  const payload = { report_manual_geography_source_version: 1, support_basis: 'saved_editor_narrative_assertion',
    authority: 'not_established', report_binding: binding, saved_geography: value,
    limitations: ['no_named_perimeter_or_cardinal_inference', 'no_source_period_applicability', 'no_subject_containment_claim',
      'no_stock_selection_or_statistical_recalculation', 'no_geometry_repair_or_simplification', 'manual_marker_not_licensure_or_authority'] };
  const content = digest(payload), id = `report-manual-geography:${content}`;
  const geography = { status: 'incomplete', reasons: [value.reason, 'report_geographic_support_not_established'],
    revision: `manual-geography:${content}`, crs: 'EPSG:4326', geometry: value.geometry, perimeter: [],
    validation: { valid: null, connected: null, contains_subject: null, engine: null, revision: null },
    cardinal_summaries: value.cardinal_summaries };
  return freeze({ geography, source: { id, payload }, source_snapshot: { id, revision: '1',
    provider: 'Saved editor narrative geometry; not adopted report evidence', content_sha256: content,
    visibility: 'assignment', scope: target.scope, valid_from: null, valid_to: null,
    observed_at: value.binding.captured_at, historical_availability: 'unknown' },
  diagnostic: { status: value.status, reason: value.reason, assignment_revision: value.binding.assignment_revision,
    projected_sha256: value.binding.projected_sha256, source_ref: id } });
}
