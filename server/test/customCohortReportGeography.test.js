import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareCustomCohortReportGeography as prepare, completeCustomCohortReportGeography as complete,
  customCohortReportGeographyForAssessment as project, CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS as FIELDS,
  CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';

const clock = '2026-09-09T12:00:00.000Z';
const target = { organization_id: '10000000-0000-4000-8000-000000000001', report_file_id: '10000000-0000-4000-8000-000000000002',
  assignment_file_id: '41', account_id: '000000000041' };
const scope = { organization_id: target.organization_id, account_id: target.account_id,
  appraisal_case_id: '10000000-0000-4000-8000-000000000003', subject_snapshot_id: '10000000-0000-4000-8000-000000000004' };
const polygon = { type: 'Polygon', coordinates: [[[-96.85, 32.8], [-96.8, 32.8], [-96.8, 32.85], [-96.85, 32.85], [-96.85, 32.8]],
  [[-96.84, 32.81], [-96.83, 32.81], [-96.83, 32.82], [-96.84, 32.81]]] };
const oracle = { is_valid: true, validation_reason: 'Valid Geometry', postgis_version: 'synthetic-query-result-3.4' };
const hash = text => createHash('sha256').update(text).digest('hex');
function input(saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: polygon }) {
  const text = JSON.stringify(saved);
  return { target: structuredClone(target), assignment_revision: 2, captured_at: clock, projection: {
    details_type: 'object', projected_utf8_bytes: Buffer.byteLength(text), projected_sha256: hash(text), projected_json: text,
  } };
}
function savedResult(saved) {
  const admitted = prepare(input(saved));
  return complete(admitted, admitted.geometry_for_validation ? oracle : null);
}
const projectionInput = () => ({ target: { scope, report_file_id: target.report_file_id, custom_assignment_file_id: 41 },
  binding: { derived_at: clock, scope } });
function invalid(run, reason) {
  assert.throws(run, error => error.code === 'CUSTOM_COHORT_REPORT_GEOGRAPHY_INVALID' && error.reason === reason);
}
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }

test('exact fresh manual-v2 polygon and every ring survive detached admission and internal native observation', () => {
  const value = input(), original = value.projection.projected_json;
  const admitted = prepare(value); assert.equal(admitted.status, 'awaiting_topology');
  assert.deepEqual(admitted.geometry_for_validation, polygon); frozen(admitted);
  value.target.account_id = 'changed'; value.projection.projected_json = '{}';
  const result = complete(admitted, oracle);
  assert.equal(result.status, 'manual_geometry_recorded'); assert.equal(result.authority, 'not_established');
  assert.equal(result.projection.projected_json, original); assert.deepEqual(result.geometry, polygon);
  assert.equal(result.binding.target.account_id, target.account_id); assert.deepEqual(result.oracle_observation, oracle);
  assert.deepEqual(result.cardinal_summaries, { north: null, east: null, south: null, west: null }); frozen(result);
});

test('literal cardinal text is not inferred; missing, blank and unusable whitespace remain null with raw values retained', () => {
  const result = savedResult({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: polygon,
    neighborhood_boundary_north: 'Recorded North Road', neighborhood_boundary_east: '', neighborhood_boundary_south: null,
    neighborhood_boundary_west: '  Recorded West Road  ', neighborhood_boundary_saved_at: 'user-entered-not-a-source-clock',
    neighborhood_boundary_confirmed: false });
  assert.equal(result.status, 'manual_geometry_recorded');
  assert.deepEqual(result.cardinal_summaries, { north: 'Recorded North Road', east: null, south: null, west: null });
  assert.equal(JSON.parse(result.projection.projected_json).neighborhood_boundary_west, '  Recorded West Road  ');
  assert.equal(result.binding.captured_at, clock);
});

for (const source of ['appraiser_defined_area_manual_v1', 'neighborhood_boundary_engine_v6', 'sales_comparison_market_conditions',
  'neighborhood_boundary_automatic_unverified_v1', 'APPRAISER_DEFINED_AREA_MANUAL_V2', 'appraiser_defined_area_manual_v2 ', '', null]) {
  test(`source ${JSON.stringify(source)} cannot manufacture fresh manual intent, even confirmed`, () => {
    const result = savedResult({ neighborhood_boundary_source: source, neighborhood_boundary_geometry: polygon,
      neighborhood_boundary_confirmed: true, neighborhood_boundary_confirmed_at: clock });
    assert.equal(result.status, 'intent_unverified'); assert.equal(result.geometry, null); assert.equal(result.oracle_observation, null);
    assert.ok(result.projection.projected_json.includes('Polygon'));
  });
}
test('confirmed alone is not drawing intent', () => {
  assert.equal(savedResult({ neighborhood_boundary_geometry: polygon, neighborhood_boundary_confirmed: true }).status, 'intent_unverified');
});

test('missing, SQL-null, JSON-null and explicit cleared states remain distinguishable without fallback', () => {
  const absent = savedResult({}), explicit = savedResult({ neighborhood_boundary_geometry: null });
  assert.equal(absent.status, 'absent'); assert.equal(explicit.status, 'absent');
  assert.notEqual(absent.binding.projected_sha256, explicit.binding.projected_sha256);
  for (const type of ['sql_null', 'null']) {
    const value = input(); value.projection = { details_type: type, projected_utf8_bytes: null, projected_sha256: null, projected_json: null };
    const result = complete(prepare(value), null); assert.equal(result.status, 'absent'); assert.equal(result.reason, `assignment_details_${type}`);
  }
  assert.equal(savedResult({ neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null }).status, 'cleared');
  assert.equal(savedResult({ neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: polygon }).status, 'malformed');
  assert.equal(savedResult({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2' }).status, 'malformed');
});

for (const type of ['string', 'array', 'number', 'boolean']) test(`saved assignment ${type} is malformed rather than an empty successful boundary`, () => {
  const value = input(); value.projection = { details_type: type, projected_utf8_bytes: null, projected_sha256: null, projected_json: null };
  assert.equal(complete(prepare(value), null).status, 'malformed');
});

for (const [name, geometry] of [
  ['numeric-string coordinate', { type: 'Polygon', coordinates: [[['-96.8', 32.8], [-96.7, 32.8], [-96.7, 32.9], ['-96.8', 32.8]]] }],
  ['open ring', { type: 'Polygon', coordinates: [[[-96.8, 32.8], [-96.7, 32.8], [-96.7, 32.9], [-96.8, 32.9]]] }],
  ['third dimension', { type: 'Polygon', coordinates: [[[-96.8, 32.8, 1], [-96.7, 32.8, 1], [-96.7, 32.9, 1], [-96.8, 32.8, 1]]] }],
  ['out of extent', { type: 'Polygon', coordinates: [[[181, 0], [179, 0], [179, 1], [181, 0]]] }],
  ['degenerate', { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0], [0, 0]]] }],
  ['multipolygon', { type: 'MultiPolygon', coordinates: [polygon.coordinates] }],
  ['private geometry key', { ...polygon, verified: true }],
]) test(`${name} is refused structurally with no repair or oracle request`, () => {
  const value = input({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: geometry });
  const admitted = prepare(value); assert.equal(admitted.status, 'malformed'); assert.equal(admitted.geometry_for_validation, null);
  const result = complete(admitted, null); assert.equal(result.geometry, null); assert.equal(result.projection.projected_json, value.projection.projected_json);
});

test('self-intersection is not silently repaired or judged by a structural check; actual owner invalid result clears report shape only', () => {
  const bowtie = { type: 'Polygon', coordinates: [[[-96.8, 32.8], [-96.7, 32.9], [-96.7, 32.8], [-96.8, 32.9], [-96.8, 32.8]]] };
  const value = input({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: bowtie });
  const admitted = prepare(value); assert.deepEqual(admitted.geometry_for_validation, bowtie);
  const result = complete(admitted, { ...oracle, is_valid: false, validation_reason: 'Self-intersection at synthetic coordinate' });
  assert.equal(result.status, 'invalid_topology'); assert.equal(result.geometry, null);
  assert.equal(result.projection.projected_json, value.projection.projected_json); assert.equal(result.oracle_observation.is_valid, false);
});

test('projection byte cap and geometry work limits are explicit, never clipped', () => {
  assert.equal(FIELDS.length, 10); assert.equal(LIMITS.projected_utf8_bytes, 262144);
  const value = input(); value.projection = { details_type: 'object', projected_utf8_bytes: LIMITS.projected_utf8_bytes + 1,
    projected_sha256: null, projected_json: null };
  assert.equal(prepare(value).status, 'limit_exceeded');
  const rings = Array.from({ length: LIMITS.rings + 1 }, () => [[0, 0], [1, 0], [1, 1], [0, 0]]);
  assert.equal(prepare(input({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: rings } })).reason, 'geometry_ring_limit');
  const positions = Array.from({ length: LIMITS.coordinates + 1 }, (_, i) => [i % 2, 0]);
  assert.equal(prepare(input({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [positions] } })).reason, 'geometry_coordinate_limit');
});

test('exact saved PostgreSQL text digest and length are checked, not replaced by canonical-equivalent bytes', () => {
  const value = input(); value.projection.projected_json = value.projection.projected_json.replace(':', ': ');
  invalid(() => prepare(value), 'projection_digest');
  value.projection.projected_utf8_bytes++; invalid(() => prepare(value), 'projection_digest');
  value.projection.projected_sha256 = hash(value.projection.projected_json); assert.equal(prepare(value).status, 'awaiting_topology');
  const foreign = input({ private_contact: 'not allowed', neighborhood_boundary_source: 'appraiser_defined_area_manual_v2' });
  invalid(() => prepare(foreign), 'projection_fields');
});

test('bad field types, long strings and false-as-string cannot become assertions', () => {
  for (const fields of [{ neighborhood_boundary_confirmed: 'true' }, { neighborhood_boundary_label: [] },
    { neighborhood_boundary_north: 0 }, { neighborhood_boundary_east: 'x'.repeat(501) }]) {
    const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: polygon, ...fields };
    assert.equal(savedResult(saved).status, 'malformed');
  }
});

test('closed input rejects proxies, getters and coercing target objects without evaluating them', () => {
  let invoked = 0;
  invalid(() => prepare(new Proxy({}, { getPrototypeOf() { invoked++; throw Error('no'); } })), 'input_shape');
  invalid(() => prepare({ target: {}, assignment_revision: 1, projection: {}, get captured_at() { invoked++; throw Error('no'); } }), 'input_shape');
  const value = input(); value.target.organization_id = { toString() { invoked++; throw Error('no'); } };
  invalid(() => prepare(value), 'target'); assert.equal(invoked, 0);
});

test('only exact module-created admissions/finals are consumed; an oracle is required only for admitted fresh manual geometry', () => {
  const admitted = prepare(input()); invalid(() => complete(structuredClone(admitted), oracle), 'admission_identity');
  invalid(() => complete(admitted, { ...oracle, supported: true }), 'input_shape');
  invalid(() => complete(admitted, { ...oracle, is_valid: 'true' }), 'oracle');
  invalid(() => complete(prepare(input({})), oracle), 'unexpected_oracle');
  const result = complete(admitted, oracle);
  invalid(() => project(structuredClone(result), projectionInput()), 'completed_identity');
});

test('report projection retains exact source/oracle while all geographic applicability remains unknown', () => {
  const result = complete(prepare(input()), oracle), projected = project(result, projectionInput());
  assert.deepEqual(projected.geography.geometry, polygon); assert.equal(projected.geography.status, 'incomplete');
  assert.deepEqual(projected.geography.perimeter, []);
  assert.deepEqual(projected.geography.validation, { valid: null, connected: null, contains_subject: null, engine: null, revision: null });
  assert.equal(projected.source_snapshot.valid_from, null); assert.equal(projected.source_snapshot.valid_to, null);
  assert.equal(projected.source_snapshot.historical_availability, 'unknown'); assert.equal(projected.source_snapshot.visibility, 'assignment');
  assert.equal(projected.source_snapshot.content_sha256, digest(projected.source.payload));
  assert.equal(projected.source.payload.saved_geography, result); assert.equal(projected.diagnostic.assignment_revision, 2); frozen(projected);
});

test('cross-target and future owner clock fail before geographic content can enter the assessment', () => {
  const result = complete(prepare(input()), oracle), expected = projectionInput();
  expected.target.custom_assignment_file_id = 42; invalid(() => project(result, expected), 'report_binding');
  const value = input(); value.captured_at = '2026-09-09T12:00:00.001Z';
  invalid(() => project(complete(prepare(value), oracle), projectionInput()), 'report_binding');
});
