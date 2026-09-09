import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { representCustomCohortSubjectPoint } from '../src/services/neighborhoodAssessment/customCohortSubjectPoint.js';

function fixture(changeLocation = {}, changeRow = {}) {
  const target = { organization_id: '11111111-1111-4111-8111-111111111111',
    report_file_id: '22222222-2222-4222-8222-222222222222', workflow_type: 'custom_appraisal',
    assignment_file_id: '37', account_id: '26355500170360000',
    appraisal_case_id: '33333333-3333-4333-8333-333333333333',
    subject_snapshot_id: '44444444-4444-4444-8444-444444444444', snapshot_version: 1 };
  const location = { account_id: target.account_id, latitude: 32.910000000000004, longitude: -96.65,
    status: 'matched', source: 'dcad_parcel_query', precision: 'parcel_centroid', confidence: 'high',
    match_method: 'parcel_id', source_parcel_id: target.account_id, feature_count: 1,
    review_required: false, review_reason: null, metadata: { address_agreement: true, queried_feature_count: 2 },
    geocoded_at: '2026-08-01T10:00:00.123Z', source_updated_at: '2026-07-31T15:00:00.000Z', ...changeLocation };
  const subject = { custom_property_snapshot: { account: { account_id: target.account_id }, location } };
  const row = { id: target.subject_snapshot_id, appraisal_case_id: target.appraisal_case_id, snapshot_version: 1,
    created_at: '2026-08-01 11:00:00.123456+00',
    subject_data: { state: 'present', pg_text: JSON.stringify(subject) }, ...changeRow };
  const original = { pg_row_json: JSON.stringify(row) };
  return { subject_input_version: 1, usage: 'retained_subject_inputs_only', target,
    original_snapshot_row: prepareNeighborhoodCohortBlob(canonicalAssessmentJson(original)),
    original_snapshot: original, snapshot: { subject_data: JSON.parse(JSON.stringify(subject)) } };
}

test('represents the original point without rounding and binds its original row evidence', () => {
  const retained = fixture(), before = JSON.stringify(retained);
  const point = representCustomCohortSubjectPoint(retained);
  assert.equal(point.status, 'represented');
  assert.deepEqual(point.geometry_input, { geometry_version: 1, type: 'Point', crs: 'EPSG:4326',
    axis_order: 'longitude_latitude', coordinate_encoding: 'decimal_string_v1',
    coordinates: ['-96.65', '32.910000000000004'], source_sha256: retained.original_snapshot_row.content_sha256 });
  assert.deepEqual(point.recorded_at, { snapshot_created_at: '2026-08-01T11:00:00.123456Z',
    geocoded_at: '2026-08-01T10:00:00.123000Z', source_updated_at: '2026-07-31T15:00:00.000000Z' });
  assert.equal(point.authority, 'not_established');
  assert.equal(point.provider_geometry_verified, false);
  assert.equal(point.provenance, 'retained_recorded_dcad_centroid');
  assert.ok(Object.isFrozen(point.geometry_input.coordinates));
  assert.equal(JSON.stringify(retained), before);
});

for (const [name, change, reason] of [
  ['unknown provider', { source: 'address_geocoder' }, 'recorded_source_unsupported'],
  ['unknown precision', { precision: null }, 'recorded_source_unsupported'],
  ['not matched', { status: 'invalid' }, 'recorded_location_needs_review'],
  ['review required', { review_required: true }, 'recorded_location_needs_review'],
  ['review flag absent', { review_required: undefined }, 'recorded_location_needs_review'],
  ['contradictory review reason', { review_reason: 'site_address_mismatch' }, 'recorded_location_needs_review'],
  ['low confidence', { confidence: 'low' }, 'recorded_location_needs_review'],
  ['low parcel fallback', { match_method: 'low_parcel_id' }, 'recorded_parcel_match_ambiguous'],
  ['different parcel', { source_parcel_id: '26355500170360001' }, 'recorded_parcel_match_ambiguous'],
  ['multiple parcels', { feature_count: 2 }, 'recorded_parcel_match_ambiguous'],
  ['unknown address agreement', { metadata: { address_agreement: null } }, 'recorded_parcel_match_ambiguous'],
  ['false address agreement', { metadata: { address_agreement: false } }, 'recorded_parcel_match_ambiguous'],
  ['different location account', { account_id: 'another-account' }, 'account_identity_mismatch'],
  ['missing longitude', { longitude: null }, 'coordinate_representation_unsupported'],
  ['numeric string', { latitude: '32.91' }, 'coordinate_representation_unsupported'],
  ['infinite string', { longitude: 'Infinity' }, 'coordinate_representation_unsupported'],
  ['longitude outside range', { longitude: -180.0001 }, 'coordinate_representation_unsupported'],
  ['latitude outside range', { latitude: 90.0001 }, 'coordinate_representation_unsupported'],
  ['no rounding to selector precision', { latitude: 0.1234567890123456 }, 'coordinate_representation_unsupported'],
  ['no exponent expansion', { latitude: 1e-7 }, 'coordinate_representation_unsupported'],
  ['geocode date missing', { geocoded_at: null }, 'recorded_chronology_unrepresented'],
  ['invalid calendar date', { geocoded_at: '2026-02-30T10:00:00.000Z' }, 'recorded_chronology_unrepresented'],
  ['unknown source date', { source_updated_at: undefined }, 'recorded_chronology_unrepresented'],
  ['geocode after capture', { geocoded_at: '2026-08-01T11:00:00.123457Z' }, 'recorded_chronology_inconsistent'],
  ['source after geocode', { source_updated_at: '2026-08-01T10:00:00.123001Z' }, 'recorded_chronology_inconsistent'],
]) {
  test(`requires review for ${name}; never supplies fallback coordinates`, () => {
    const point = representCustomCohortSubjectPoint(fixture(change));
    assert.equal(point.status, 'review_required');
    assert.equal(point.reason, reason);
    assert.equal(point.geometry_input, null);
  });
}

test('known absent source update stays null; zero is distinct from a missing coordinate', () => {
  const point = representCustomCohortSubjectPoint(fixture({ source_updated_at: null, latitude: 0, longitude: 0 }));
  assert.equal(point.status, 'represented');
  assert.equal(point.recorded_at.source_updated_at, null);
  assert.deepEqual(point.geometry_input.coordinates, ['0', '0']);
});

test('rejects missing originals, wrong snapshot identities and mixed represented data', () => {
  for (const value of [null, {}, { ...fixture(), usage: 'trusted_by_browser' }]) {
    assert.equal(representCustomCohortSubjectPoint(value).reason, 'retained_subject_required');
  }
  const noRef = fixture();
  delete noRef.original_snapshot_row;
  assert.equal(representCustomCohortSubjectPoint(noRef).reason, 'original_snapshot_reference_required');
  assert.equal(representCustomCohortSubjectPoint(fixture({}, { id: 'another-snapshot' })).reason, 'snapshot_identity_mismatch');
  assert.equal(representCustomCohortSubjectPoint(fixture({}, { snapshot_version: 2 })).reason, 'snapshot_identity_mismatch');
  const mixed = fixture();
  mixed.snapshot.subject_data.custom_property_snapshot.location.longitude = -97;
  assert.equal(representCustomCohortSubjectPoint(mixed).reason, 'subject_evidence_mismatch');
  const missing = fixture();
  missing.original_snapshot.pg_row_json = '{}';
  assert.equal(representCustomCohortSubjectPoint(missing).reason, 'snapshot_identity_mismatch');
});

test('retains unsupported original numeric bytes instead of parsing or repairing them', () => {
  const retained = fixture();
  retained.original_snapshot.pg_row_json = retained.original_snapshot.pg_row_json.replace('32.910000000000004', '32.91000000000000400001');
  assert.equal(representCustomCohortSubjectPoint(retained).status, 'review_required');
});

test('changed original row produces a different point-source identity, even with equal coordinates', () => {
  const first = representCustomCohortSubjectPoint(fixture());
  const second = representCustomCohortSubjectPoint(fixture({ source_updated_at: null }));
  assert.notEqual(first.geometry_input.source_sha256, second.geometry_input.source_sha256);
  assert.deepEqual(first.geometry_input.coordinates, second.geometry_input.coordinates);
});

test('native PostgreSQL offset timestamps retain exact microseconds and correct chronology', () => {
  for (const [created_at, expected] of [
    ['2026-08-01 06:00:00.123456-05', '2026-08-01T11:00:00.123456Z'],
    ['2026-08-01 16:30:00.123456+05:30', '2026-08-01T11:00:00.123456Z'],
    ['2026-08-02 01:00:00.123456+14', '2026-08-01T11:00:00.123456Z'],
  ]) {
    const point = representCustomCohortSubjectPoint(fixture({}, { created_at }));
    assert.equal(point.status, 'represented', point.reason);
    assert.equal(point.recorded_at.snapshot_created_at, expected);
  }
  for (const created_at of ['2026-02-30 06:00:00-05', '2026-08-01 06:00:00-15',
    '2026-08-01 06:00:00+14:01', '2026-08-01 06:00:00+05:60', '2026-08-01 06:00:00',
    '0001-01-01 00:00:00+01', '9999-12-31 23:59:59-01']) {
    assert.equal(representCustomCohortSubjectPoint(fixture({}, { created_at })).reason, 'recorded_chronology_unrepresented');
  }
  const after = representCustomCohortSubjectPoint(fixture({ geocoded_at: '2026-08-01 06:00:00.123457-05' },
    { created_at: '2026-08-01 06:00:00.123456-05' }));
  assert.equal(after.reason, 'recorded_chronology_inconsistent');
});
