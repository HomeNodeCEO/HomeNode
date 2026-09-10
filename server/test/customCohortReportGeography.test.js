import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareCustomCohortReportGeography as prepare, completeCustomCohortReportGeography as complete,
  customCohortReportGeographyForAssessment as project, CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS as FIELDS,
  CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { assessmentEvidenceDigest as digest, canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { representCustomCohortSubjectPoint } from '../src/services/neighborhoodAssessment/customCohortSubjectPoint.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

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

// Synthetic stored rows/oracle results exercise admission only. Actual PostGIS
// containment, native storage and current-subject fences are owner-suite checks.
function retainedSubject(locationChanges = {}, rowChanges = {}) {
  const subjectTarget = { ...target, workflow_type: 'custom_appraisal', appraisal_case_id: scope.appraisal_case_id,
    subject_snapshot_id: scope.subject_snapshot_id, snapshot_version: 1 };
  const location = { account_id: target.account_id, longitude: -96.82, latitude: 32.84,
    source: 'dcad_parcel_query', precision: 'parcel_centroid', status: 'matched', confidence: 'high', review_required: false,
    review_reason: null, match_method: 'parcel_id', source_parcel_id: target.account_id, feature_count: 1,
    metadata: { address_agreement: true }, geocoded_at: '2026-09-08T10:00:00.123456Z', source_updated_at: null,
    ...locationChanges };
  const subject = { custom_property_snapshot: { account: { account_id: target.account_id }, location } };
  const row = { id: scope.subject_snapshot_id, appraisal_case_id: scope.appraisal_case_id, snapshot_version: 1,
    created_at: '2026-09-08 11:00:00.123456+00', subject_data: { state: 'present', pg_text: JSON.stringify(subject) }, ...rowChanges };
  const original = { pg_row_json: JSON.stringify(row) };
  return { subject_input_version: 1, usage: 'retained_subject_inputs_only', target: subjectTarget,
    original_snapshot_row: prepareNeighborhoodCohortBlob(json(original)), original_snapshot: original,
    snapshot: { subject_data: structuredClone(subject) } };
}
const pointOracle = (covers = true, contains = true) => ({ ...oracle, geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
  covers_recorded_subject_point: covers, contains_recorded_subject_point: contains });
const pointInput = (subject = retainedSubject(), saved) => ({ ...input(saved), retained_subject: subject });

test('old no-subject admission, completion and assessment bytes stay pinned, with no optional keys', () => {
  // Captured before the optional retained-subject source edits; do not regenerate.
  const values = [{ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: polygon }, {},
    { neighborhood_boundary_source: 'appraiser_defined_area_manual_v1', neighborhood_boundary_geometry: polygon },
    { neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null }].map(saved => {
    const admission = prepare(input(saved)), completed = complete(admission, admission.geometry_for_validation ? oracle : null);
    assert.equal(Object.hasOwn(admission, 'subject_point_for_validation'), false);
    assert.equal(Object.hasOwn(completed, 'subject_point_observation'), false);
    return { admission, completed, projected: project(completed, projectionInput()) };
  });
  assert.equal(hash(json(values)), '116eeb8b46cdb9ac6b258beea89ce0585b415900a82d39feae9bc410b5294043');
});

test('opt-in retains unchanged decimal-string point, original row reference, clocks and detached full provenance', () => {
  const subject = retainedSubject({ latitude: 32.910000000000004 }), expected = representCustomCohortSubjectPoint(subject);
  const value = pointInput(subject), before = json(value), admitted = prepare(value);
  assert.equal(Object.hasOwn(admitted, 'retained_subject'), false);
  assert.deepEqual(admitted.subject_point_for_validation, expected.geometry_input);
  assert.deepEqual(admitted.subject_point_for_validation.coordinates, ['-96.82', '32.910000000000004']);
  const result = complete(admitted, pointOracle());
  assert.equal(json(value), before);
  assert.deepEqual(result.subject_point_observation.point, expected);
  assert.deepEqual(result.subject_point_observation.retained_subject_binding, { target: subject.target, original_snapshot_row: subject.original_snapshot_row });
  assert.equal(result.subject_point_observation.point.provider_geometry_verified, false);
  assert.equal(result.subject_point_observation.point.authority, 'not_established');
  subject.target.account_id = 'changed'; subject.snapshot.subject_data.custom_property_snapshot.location.longitude = -97;
  assert.equal(result.subject_point_observation.point.target.account_id, target.account_id);
  assert.equal(result.subject_point_observation.point.geometry_input.coordinates[0], '-96.82');
  assert.equal(result.subject_point_observation.point.recorded_at.snapshot_created_at, '2026-09-08T11:00:00.123456Z');
  frozen(admitted); frozen(result);
});

test('genuinely captured, persisted and reopened subject graph feeds the same representation helper without a new lookup', async () => {
  const fixture = await decisionEvidenceFixture(), subject = fixture.input.retained_inputs.subject;
  const value = pointInput(subject); value.target = Object.fromEntries(Object.keys(target).map(key => [key, subject.target[key]]));
  const expected = representCustomCohortSubjectPoint(subject);
  const admitted = prepare(value), result = complete(admitted, pointOracle(false, false));
  assert.equal(expected.status, 'represented');
  assert.deepEqual(admitted.subject_point_for_validation, expected.geometry_input);
  assert.deepEqual(result.subject_point_observation.point, expected);
  assert.deepEqual(result.subject_point_observation.retained_subject_binding.original_snapshot_row, subject.original_snapshot_row);
  assert.equal(result.subject_point_observation.relation.status, 'observed');
  assert.equal(result.geometry.type, 'Polygon');
});

for (const [name, covers, contains] of [['interior', true, true], ['outside or hole interior', false, false], ['exterior or hole boundary', true, false]]) {
  test(`native ${name} diagnostic is preserved separately; it neither removes the polygon nor sets subject containment`, () => {
    const result = complete(prepare(pointInput()), pointOracle(covers, contains));
    assert.deepEqual(result.subject_point_observation.relation, { status: 'observed', reason: null,
      covers_recorded_subject_point: covers, contains_recorded_subject_point: contains });
    assert.deepEqual(result.geometry, polygon); assert.equal(result.status, 'manual_geometry_recorded');
    const projected = project(result, projectionInput());
    assert.equal(projected.geography.status, 'incomplete');
    assert.deepEqual(projected.geography.validation, { valid: null, connected: null, contains_subject: null, engine: null, revision: null });
    assert.deepEqual(projected.geography.perimeter, []);
    assert.equal(projected.source.payload.saved_geography.subject_point_observation, result.subject_point_observation);
    assert.equal(projected.source_snapshot.historical_availability, 'unknown');
    assert.equal(projected.source_snapshot.valid_from, null); assert.equal(projected.source_snapshot.valid_to, null);
    assert.equal(projected.source_snapshot.content_sha256, digest(projected.source.payload));
  });
}

test('invalid native topology requires null point predicates and retains point provenance without a report shape', () => {
  const admitted = prepare(pointInput());
  const invalidOracle = { ...pointOracle(null, null), is_valid: false, validation_reason: 'Self-intersection' };
  const result = complete(admitted, invalidOracle);
  assert.equal(result.geometry, null); assert.equal(result.status, 'invalid_topology');
  assert.equal(result.subject_point_observation.point.status, 'represented');
  assert.deepEqual(result.subject_point_observation.relation, { status: 'unavailable', reason: 'native_geometry_invalid',
    covers_recorded_subject_point: null, contains_recorded_subject_point: null });
  invalid(() => complete(admitted, { ...invalidOracle, covers_recorded_subject_point: false }), 'oracle_point_relation');
});

for (const [name, changes, reason] of [
  ['unknown coordinate', { longitude: null }, 'coordinate_representation_unsupported'],
  ['coordinate string', { longitude: '-96.82' }, 'coordinate_representation_unsupported'],
  ['ambiguous parcel', { feature_count: 2 }, 'recorded_parcel_match_ambiguous'],
  ['fresh unrelated location source', { source: 'account_locations' }, 'recorded_source_unsupported'],
]) test(`${name} has no fallback; null relation is distinct from observed false`, () => {
  const admitted = prepare(pointInput(retainedSubject(changes)));
  assert.equal(admitted.subject_point_for_validation, null);
  const result = complete(admitted, pointOracle(null, null));
  assert.equal(result.subject_point_observation.point.reason, reason);
  assert.equal(result.subject_point_observation.relation.status, 'unavailable');
  assert.equal(result.subject_point_observation.relation.reason, 'retained_subject_point_unavailable');
  assert.equal(result.subject_point_observation.relation.covers_recorded_subject_point, null);
  assert.deepEqual(result.geometry, polygon);
  invalid(() => complete(admitted, pointOracle(false, false)), 'oracle_point_relation');
});

test('absent, cleared, old/manual-unverified, malformed and limited geometry retain the bound point but perform no oracle', () => {
  const states = [{}, { neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null },
    { neighborhood_boundary_source: 'appraiser_defined_area_manual_v1', neighborhood_boundary_geometry: polygon },
    { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [] } }];
  const limited = pointInput(); limited.projection = { details_type: 'object', projected_utf8_bytes: LIMITS.projected_utf8_bytes + 1,
    projected_sha256: null, projected_json: null };
  for (const value of [...states.map(saved => pointInput(retainedSubject(), saved)), limited]) {
    const admitted = prepare(value), result = complete(admitted, null);
    assert.equal(admitted.geometry_for_validation, null); assert.notEqual(admitted.subject_point_for_validation, null);
    assert.equal(result.subject_point_observation.relation.reason, 'manual_geometry_not_admitted');
    assert.equal(result.subject_point_observation.relation.covers_recorded_subject_point, null);
    invalid(() => complete(admitted, pointOracle()), 'unexpected_oracle');
  }
});

for (const fields of [{ geometry_type: 'ST_MultiPolygon' }, { geometry_type: 'Polygon' }, { is_empty: true }, { component_count: 0 },
  { component_count: 2 }, { component_count: '1' }]) test(`valid structural Polygon rejects contradictory native metadata ${JSON.stringify(fields)}`, () => {
  invalid(() => complete(prepare(pointInput()), { ...pointOracle(), ...fields }), 'oracle_geometry');
});
for (const [covers, contains] of [[false, true], [null, false], [true, null], ['true', true], [1, true]]) {
  test(`represented valid point rejects contradictory or absent relation ${JSON.stringify([covers, contains])}`, () => {
    invalid(() => complete(prepare(pointInput()), pointOracle(covers, contains)), 'oracle_point_relation');
  });
}

test('old and opt-in oracle shapes cannot be interchanged or carry arbitrary assertions', () => {
  invalid(() => complete(prepare(pointInput()), oracle), 'input_shape');
  invalid(() => complete(prepare(input()), pointOracle()), 'input_shape');
  invalid(() => complete(prepare(pointInput()), { ...pointOracle(), contains_whole_subject: true }), 'input_shape');
  invalid(() => complete(structuredClone(prepare(pointInput())), pointOracle()), 'admission_identity');
});

test('every exact retained target component is checked without account aliases', () => {
  for (const key of Object.keys(target)) {
    const subject = retainedSubject(); subject.target[key] = key === 'account_id' ? '41' : key === 'assignment_file_id' ? '42'
      : '20000000-0000-4000-8000-000000000001';
    invalid(() => prepare(pointInput(subject)), 'retained_subject_binding');
  }
  const subject = retainedSubject(); subject.target.workflow_type = 'uad';
  invalid(() => prepare(pointInput(subject)), 'retained_subject_binding');
});

test('same-file case/snapshot rebind is rejected by the actual assessment consumer, including unavailable point', () => {
  for (const changes of [{}, { longitude: null }]) for (const key of ['appraisal_case_id', 'subject_snapshot_id']) {
    const result = complete(prepare(pointInput(retainedSubject(changes))), pointOracle(changes.longitude === null ? null : true,
      changes.longitude === null ? null : true));
    const expected = projectionInput(); expected.target = { ...expected.target, scope: { ...scope, [key]: '20000000-0000-4000-8000-000000000002' } };
    invalid(() => project(result, expected), 'report_subject_binding');
  }
});

test('original row hash/length and represented subject equality cannot be detached from the bound point', () => {
  const changed = retainedSubject(); changed.original_snapshot.pg_row_json += ' ';
  invalid(() => prepare(pointInput(changed)), 'retained_subject_reference');
  const differentLength = retainedSubject(); differentLength.original_snapshot_row = { ...differentLength.original_snapshot_row, canonical_utf8_bytes: '2' };
  invalid(() => prepare(pointInput(differentLength)), 'retained_subject_reference');
  const represented = retainedSubject(); represented.snapshot.subject_data.custom_property_snapshot.location.longitude = -97;
  const result = complete(prepare(pointInput(represented)), pointOracle(null, null));
  assert.equal(result.subject_point_observation.point.reason, 'subject_evidence_mismatch');
  assert.equal(result.subject_point_observation.relation.covers_recorded_subject_point, null);
});

test('point snapshot clock uses full retained microseconds against the actual owner observation clock', () => {
  const equal = retainedSubject({}, { created_at: '2026-09-09 12:00:00.000000+00' });
  assert.notEqual(prepare(pointInput(equal)).subject_point_for_validation, null);
  invalid(() => prepare(pointInput(retainedSubject({}, { created_at: '2026-09-09 12:00:00.000001+00' }))), 'retained_subject_clock');
});

test('optional retained input rejects hostile accessors/proxies before the representation helper can execute them', () => {
  let invoked = 0;
  const getter = () => { invoked++; throw Error('must not execute'); };
  const top = pointInput(); Object.defineProperty(top, 'retained_subject', { enumerable: true, get: getter });
  invalid(() => prepare(top), 'input_shape');
  const subject = retainedSubject(); Object.defineProperty(subject.snapshot.subject_data.custom_property_snapshot.location, 'longitude', { enumerable: true, get: getter });
  invalid(() => prepare(pointInput(subject)), 'retained_subject_shape');
  const proxied = retainedSubject(); proxied.snapshot.subject_data = new Proxy({}, { getPrototypeOf: getter, get: getter });
  invalid(() => prepare(pointInput(proxied)), 'retained_subject_shape');
  invalid(() => prepare(pointInput(null)), 'retained_subject_shape');
  assert.equal(invoked, 0);
});
