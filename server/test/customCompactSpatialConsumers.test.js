import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { encodeSpatialParcel, decodeSpatialParcel, SPATIAL_PARCEL_TUPLE_ENCODING } from '../src/services/neighborhoodAssessment/spatialMembershipEncoding.js';
import { prepareCustomCohortCaptureInputs as prepare, prepareCustomCohortCaptureInputsBatched as prepareBatched,
  persistCustomCohortCaptureInputs as persist, loadCustomCohortCaptureInputs as load } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { buildCustomCohortParcelMap as parcelMap, buildCustomCohortParcelMapBatched as parcelMapBatched,
  buildCustomCohortParcelGeometryIndex as geometryIndex } from '../src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { buildCustomCohortObservationPreview as preview, buildCustomCohortIndexedObservationPreview as indexed,
  buildCustomCohortIndexedObservationPreviewBatched as indexedBatched } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog as catalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { deriveCustomCohortRecordedProximity as proximity, readCustomCohortRecordedProximity as readProximity }
  from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { recordedProximityFixture, proximityPolygon } from './fixtures/customCohortRecordedProximityFixture.js';

const sha = value => createHash('sha256').update(value).digest('hex');
function deeplyFrozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(deeplyFrozen); }
}
function compactSpatial(spatial) {
  const parcels = spatial.parcels.map(encodeSpatialParcel);
  return { ...spatial, parcel_encoding: SPATIAL_PARCEL_TUPLE_ENCODING, parcels,
    counts: { ...spatial.counts, encoded_bytes: Buffer.byteLength(JSON.stringify(parcels)) } };
}

// Only bounded query-result fakes and their in-memory blob store are used. Reuse
// the existing complete fixture rather than duplicate its capture machinery.
// A separate synthetic intent/graph is prepared with tuples BEFORE persistence;
// the fixture's already-saved expanded graph and context are never relabeled.
const pair = (async () => {
  const hole = proximityPolygon();
  hole.coordinates.push(proximityPolygon(-96.6498, 32.9102, .0001).coordinates[0].reverse());
  const f = await recordedProximityFixture({ parcels: [
    { account_id: 'subject', geometry: hole },
    { account_id: 'R-001', geometry: { type: 'MultiPolygon',
      coordinates: [proximityPolygon(-96.64).coordinates, proximityPolygon(-96.63).coordinates] } },
    { account_id: 'R-001', geometry: proximityPolygon(-96.62) },
  ] });
  const oldBytes = JSON.stringify(f.retained_inputs), oldHeader = f.input.context_header_json;
  const original = structuredClone(f.retained_inputs);
  original.spatial = compactSpatial(original.spatial);
  original.acquisition_intent.body.operation_id = '70000000-0000-4000-8000-000000000001';
  original.acquisition_intent.reference = await f.store.put(json(original.acquisition_intent.body));
  const originalBytes = JSON.stringify(original), prepared = prepare(original);
  const refs = await persist(f.client, f.scopeJson, prepared);
  const reopened = await load(f.client, f.scopeJson, refs);
  const header = prepareCustomCohortContextHeader(json({ ...JSON.parse(oldHeader),
    context_id: original.acquisition_intent.body.operation_id, ...refs }));
  assert.equal(JSON.stringify(original), originalBytes);
  assert.equal(JSON.stringify(f.retained_inputs), oldBytes);
  assert.equal(f.input.context_header_json, oldHeader);
  return { f, original, originalBytes, prepared, refs, reopened, context: header.context_ref, oldBytes, oldHeader };
})();

test('new compact originals persist and reopen literally while old expanded inputs and references remain unchanged', async () => {
  const { f, original, originalBytes, prepared, refs, reopened, oldBytes, oldHeader } = await pair;
  assert.equal(prepared.status, 'prepared'); assert.equal(reopened.status, 'retained');
  assert.deepEqual(reopened.refs, refs);
  assert.deepEqual(reopened.retained_inputs, original);
  assert.deepEqual(reopened.summary, prepared.summary);
  assert.equal(reopened.retained_inputs.spatial.parcel_encoding, 'fixed_fields_v1');
  assert.deepEqual(reopened.retained_inputs.spatial.parcels.map(decodeSpatialParcel), f.retained_inputs.spatial.parcels);
  assert.ok(reopened.retained_inputs.spatial.parcels.every(row => Array.isArray(row) && row.length === 7));
  assert.equal(reopened.retained_inputs.spatial.parcels[0][0], '9007199254740993');
  assert.equal(reopened.retained_inputs.spatial.parcels[0][4], '2026-09-06T08:00:00.123456Z');
  assert.equal(reopened.retained_inputs.spatial.parcels[0][5], null);
  deeplyFrozen(reopened);
  assert.equal(JSON.stringify(original), originalBytes);
  assert.equal(JSON.stringify(f.retained_inputs), oldBytes);
  assert.equal(f.input.context_header_json, oldHeader);
  const oldRefs = Object.fromEntries(['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input']
    .map(key => [key, JSON.parse(oldHeader)[key]]));
  assert.deepEqual(prepare(f.retained_inputs).refs, oldRefs);
  assert.notDeepEqual(refs.selection_input, oldRefs.selection_input);
  assert.deepEqual(refs.subject_dependencies, oldRefs.subject_dependencies);
  assert.deepEqual(refs.study_input, oldRefs.study_input);
});

test('compact byte counts, original membership digest, source digests, and all stored blob hashes remain complete', async () => {
  const { f, reopened } = await pair, retained = reopened.retained_inputs, spatial = retained.spatial;
  const expanded = spatial.parcels.map(decodeSpatialParcel);
  assert.equal(spatial.counts.encoded_bytes, Buffer.byteLength(JSON.stringify(spatial.parcels)));
  assert.equal(spatial.counts.bytes, expanded.reduce((sum, row) => sum + Buffer.byteLength(json(row)), 0));
  assert.equal(spatial.counts.bytes, f.retained_inputs.spatial.counts.bytes);
  assert.ok(spatial.counts.encoded_bytes < spatial.counts.bytes);
  const digest = createHash('sha256').update('homenode-cached-spatial-membership-v1\n')
    .update(json({ geometry_input: spatial.geometry_input, radius_metres: '4828.032',
      distance_semantics: 'postgis_geography_spheroid_v1' })).update('\n');
  for (const row of expanded) digest.update(json(row)).update('\n');
  assert.equal(spatial.membership_sha256, digest.digest('hex'));
  assert.equal(spatial.membership_sha256, f.retained_inputs.spatial.membership_sha256);
  assert.equal(spatial.account_ids_sha256, assessmentEvidenceDigest({ account_ids: spatial.account_ids }));
  const capture = retained.acquisition.capture_result.source_capture;
  assert.deepEqual(capture, f.retained_inputs.acquisition.capture_result.source_capture);
  for (const source of capture.sources) {
    const snapshot = capture.source_snapshots.find(row => row.id === source.id);
    assert.equal(snapshot.content_sha256, assessmentEvidenceDigest(source.payload));
    for (const row of source.payload.records) if (row.data.raw_projection) {
      const mapped = row.data;
      assert.equal(mapped.data.cached_projection_sha256, assessmentEvidenceDigest({
        mapping_version: mapped.data.cached_mapping_version,
        projection_kind: mapped.data.cached_projection_kind, raw_projection: mapped.raw_projection }));
    }
  }
  assert.ok(f.f.state.db.size > 10);
  for (const stored of f.f.state.db.values()) {
    assert.equal(stored.content_sha256, sha(stored.canonical_utf8));
    assert.equal(Number(stored.canonical_utf8_bytes), Buffer.byteLength(stored.canonical_utf8));
  }
});

for (const selected of [undefined, [], ['R-001']]) test(`compact map/index retain exact geometry and selected-count parity (${JSON.stringify(selected)})`, async () => {
  const { f, reopened } = await pair;
  const old = { retained_inputs: f.retained_inputs, selected_account_ids: selected };
  const next = { retained_inputs: reopened.retained_inputs, selected_account_ids: selected };
  const expected = parcelMap(old), actual = parcelMap(next), oldIndex = geometryIndex(old), nextIndex = geometryIndex(next);
  assert.equal(actual.status, 'available'); assert.equal(nextIndex.status, 'available');
  assert.deepEqual(actual, expected); assert.deepEqual(nextIndex, oldIndex);
  assert.deepEqual(await parcelMapBatched(next), actual);
  assert.deepEqual(nextIndex.counts, actual.counts);
  assert.deepEqual(nextIndex.parcels.map(row => row.component_count), [1, 2, 1]);
  assert.deepEqual(nextIndex.parcels.map(row => row.geometry_ewkb), f.parcels.map(row => row.geometry_ewkb));
  assert.equal(actual.counts.coordinates, 25);
  assert.equal(actual.counts.geojson_bytes, Buffer.byteLength(JSON.stringify(actual.geojson)));
  deeplyFrozen(actual); deeplyFrozen(nextIndex);
});

for (const shape of ['empty', 'subset', 'overlap']) test(`compact observation previews and catalog preserve exact output/work (${shape})`, async () => {
  const { f, reopened, context } = await pair;
  const pockets = shape === 'empty' ? [] : [{ id: 'picked', label: 'Picked', account_ids: ['R-001'] },
    ...(shape === 'overlap' ? [{ id: 'all', label: 'All', account_ids: [...f.accountIds] }] : [])];
  // The same explicit test context/selection isolates representation parity;
  // the separately persisted graph's own storage references differ above.
  const before = { context_ref: context, retained_inputs: f.retained_inputs, selection: { revision: 9, pockets } };
  const after = { ...before, retained_inputs: reopened.retained_inputs };
  assert.deepEqual(preview(after), preview(before));
  const expected = indexed(before), actual = indexed(after);
  assert.deepEqual(actual, expected);
  assert.deepEqual(await indexedBatched(after), actual);
  assert.deepEqual(catalog({ retained_inputs: reopened.retained_inputs, preview: actual, catalog_version: 2 }),
    catalog({ retained_inputs: f.retained_inputs, preview: expected, catalog_version: 2 }));
  assert.equal(actual.all.stock.member_count, 2);
  assert.equal(actual.all.stock.parcel_object_count, 3);
  deeplyFrozen(actual);
});

test('compact proximity preserves exact native parameters, observations, and issued-result binding checks', async () => {
  const { f, reopened, context } = await pair;
  const components = new Map(geometryIndex({ retained_inputs: f.retained_inputs }).parcels.map(row => [row.object_id, row.component_count]));
  const run = async retained_inputs => {
    const calls = [], input = { context_ref: context, retained_inputs };
    const result = await proximity(async (sql, values) => {
      calls.push({ sql, values });
      return { rows: JSON.parse(values[0]).map((row, position) => ({ object_id: row.object_id,
        valid: true, location_count: components.get(row.object_id), minimum_metres: (position + 1) * 1609.344,
        maximum_metres: (position + components.get(row.object_id)) * 1609.344 })) };
    }, input);
    assert.equal(readProximity(result, input), result);
    return { calls, result, input };
  };
  const old = await run(f.retained_inputs), next = await run(reopened.retained_inputs);
  assert.equal(next.result.status, 'available');
  assert.deepEqual(next.calls, old.calls); assert.deepEqual(next.result, old.result);
  assert.equal(next.result.accounts.find(row => row.account_id === 'R-001').location_count, 3);
  assert.throws(() => readProximity(old.result, next.input), /binding_mismatch/);
  assert.throws(() => readProximity(structuredClone(next.result), next.input), /unissued_result/);
  deeplyFrozen(next.result);
});

test('synchronous and cooperative preparation preserve the same compact references and leave originals untouched', async () => {
  const { f, original, originalBytes, prepared, oldBytes } = await pair;
  const input = structuredClone(original), before = JSON.stringify(input);
  assert.deepEqual(await prepareBatched(input), prepared);
  assert.equal(JSON.stringify(input), before); deeplyFrozen(input);
  assert.equal(JSON.stringify(original), originalBytes);
  assert.equal(JSON.stringify(f.retained_inputs), oldBytes);
});

for (const [name, change] of [
  ['encoded bytes too large', spatial => spatial.counts.encoded_bytes++],
  ['encoded bytes too small', spatial => spatial.counts.encoded_bytes--],
  ['encoded byte count missing', spatial => { delete spatial.counts.encoded_bytes; }],
  ['expanded bytes changed', spatial => spatial.counts.bytes++],
  ['parcel count changed', spatial => spatial.counts.parcels++],
  ['account count changed', spatial => spatial.counts.accounts++],
  ['unknown encoding', spatial => { spatial.parcel_encoding = 'fixed_fields_v2'; }],
  ['encoding removed from tuples', spatial => { delete spatial.parcel_encoding; }],
  ['short tuple', spatial => spatial.parcels[0].pop()],
  ['extra tuple field', spatial => spatial.parcels[0].push('unretained')],
  ['tuple column order changed', spatial => { [spatial.parcels[0][0], spatial.parcels[0][1]] = [spatial.parcels[0][1], spatial.parcels[0][0]]; }],
  ['tuple roster order changed', spatial => spatial.parcels.reverse()],
  ['duplicate tuple', spatial => { spatial.parcels[1] = [...spatial.parcels[0]]; }],
  ['source hash changed', spatial => { spatial.parcels[0][2] = 'b'.repeat(64); }],
  ['geometry hash changed', spatial => { spatial.parcels[0][6] = 'b'.repeat(64); }],
]) test(`compact original admission refuses ${name}`, async () => {
  const { original } = await pair, input = structuredClone(original);
  change(input.spatial);
  assert.throws(() => prepare(input), /custom_cohort_capture_inputs_|invalid_spatial_membership_encoding:/);
  await assert.rejects(prepareBatched(input), /custom_cohort_capture_inputs_|invalid_spatial_membership_encoding:/);
});
