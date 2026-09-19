import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { recommendationFixture } from '../../server/test/fixtures/customCohortDenseRecommendationFixture.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { buildCustomCohortIndexedObservationPreview as preview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog as catalog, presentCustomCohortPocketCatalog as presentCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation as recommend } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as presentRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { buildCustomCohortParcelMap as parcelMap } from '../../server/src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { presentCustomCohortPreview as summary } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { checkCustomCohortPocketCatalog, selectionFromRecordedGroups } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { createCustomCohortPreviewController } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { createCustomCohortPreviewTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { buildCustomCohortMapPresentation as present, CUSTOM_COHORT_MAP_PRESENTATION_LIMITS as LEGACY,
  CUSTOM_COHORT_MAP_PRESENTATION_V3_LIMITS as V3 } from '../src/features/neighborhood/customCohortMapPresentation.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
function square(index) {
  const x = -97 + index / 100000, y = 32;
  const points = [[x, y], [x + .000001, y], [x + .000001, y + .000001], [x, y + .000001], [x, y]];
  const bytes = Buffer.alloc(17 + points.length * 16);
  bytes[0] = 1; bytes.writeUInt32LE(0x20000003, 1); bytes.writeUInt32LE(4326, 5);
  bytes.writeUInt32LE(1, 9); bytes.writeUInt32LE(points.length, 13);
  points.forEach(([x, y], i) => { bytes.writeDoubleLE(x, 17 + i * 16); bytes.writeDoubleLE(y, 25 + i * 16); });
  return bytes;
}
// Actual mapping4/source builder/EWKB decoder and public browser admission.
// Synthetic observations only: no source rights, native topology, or DB claims.
function fixture(count = 2048, withUnassigned = false) {
  const accounts = Array.from({ length: count + Number(withUnassigned) }, (_, i) => `A${i.toString().padStart(5, '0')}`);
  const geometries = accounts.map((_, i) => square(i));
  const f = recommendationFixture({ accounts, subject: accounts[0], mapping4: true,
    names: withUnassigned ? { [accounts.at(-1)]: '' } : {},
    parcels: accounts.map((account_id, i) => ({ account_id, residential_year_built: 2000,
      residential_area_sqft: '1800', parcel_area_sqft: '6000', current_market_value: '330000',
      source_record_hash: sha(`synthetic:${i}`), stored_geometry_ewkb: geometries[i].toString('hex') })) });
  f.retained_inputs.spatial.parcels.forEach((p, i) => {
    p.source_record_hash = sha(`synthetic:${i}`); p.geometry_sha256 = sha(geometries[i]);
  });
  f.retained_inputs.spatial.status = 'captured';
  const captured = f.retained_inputs.acquisition.capture_result, scope = captured.source_capture.scope;
  const roles = new Map();
  for (const source of captured.source_capture.sources) {
    const role = source.payload.projection.definition.role;
    if (!roles.has(role)) roles.set(role, []);
    roles.get(role).push(...source.payload.records.map(record => role === 'parcels'
      ? { record_id: `parcel:${record.data.raw_projection.object_id}`, data: record.data } : record));
  }
  // The observation-only fixture uses a different outer parcel routing key.
  // Construct NEW synthetic source envelopes with the real map reader's route;
  // never relabel an existing immutable capture or keep its old content hashes.
  captured.source_capture = buildCachedSourceCaptures({ scope, captures: [...roles].map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'synthetic-map-v3', content_sha256: 'a'.repeat(64), captured_at: captured.captured_at,
      visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic catalog map fixture', revision: 'synthetic-map-v3',
      valid_from: null, valid_to: null, observed_at: captured.captured_at, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'synthetic-map-v3', definition: { role, mapping_version: 4 },
      complete: true, input_row_count: records.length, output_record_count: records.length }, records,
  })) });
  captured.status = 'captured'; assert.equal(captured.source_capture.status, 'ready');
  const input = { accountId: accounts[0], assignmentFileId: f.retained_inputs.subject.target.assignment_file_id,
    contextRef: f.context_ref, selection: { revision: 1, pockets: [] } };
  const expected = { context_ref: f.context_ref, selection_revision: 1 }, all = preview({ ...f, selection: input.selection });
  const raw = presentCatalog({ preview: all, expected, catalog: catalog({ retained_inputs: f.retained_inputs, preview: all, catalog_version: 3 }) });
  const recommendation = presentRecommendation({ catalog: raw, expected,
    recommendation: recommend({ ...f, catalog_version: 3, observation_preview: all, include_stock_composition: true }) });
  const envelope = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: f.context_ref, selection_revision: 1, subject_freshness: 'matched', catalog: raw, recommendation, apply: { status: 'blocked' } };
  return { f, input, envelope };
}
async function admittedMap(f, input, checked) {
  const selected = { ...input, selection: selectionFromRecordedGroups(checked, checked.pockets.map(p => p.id), 2) };
  const observations = preview({ ...f, selection: selected.selection });
  const map = parcelMap({ retained_inputs: f.retained_inputs, selected_account_ids: selected.selection.pockets.flatMap(p => p.account_ids) });
  assert.equal(map.status, 'available', map.reason);
  const response = { status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: input.contextRef, selection_revision: 2, subject_freshness: 'matched',
    summary: summary({ preview: observations, expected: { context_ref: input.contextRef, selection_revision: 2 } }),
    parcel_map: map, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
  const transport = createCustomCohortPreviewTransport({ urlFor: path => path,
    request: async () => new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }) });
  let controller;
  try {
    const group = await new Promise((resolve, reject) => {
      controller = createCustomCohortPreviewController({ fingerprint: async text => sha(text), transport,
        timer: { set(callback, ms) { return setTimeout(callback, ms === 250 ? 0 : ms); }, clear: clearTimeout },
        onChange(state) { if (state.status === 'ready') resolve(state.group); else if (state.status === 'failed') reject(new Error(state.error)); } });
      controller.setSelection(selected);
    });
    assert.deepEqual(group.parcel_map.geojson, map.geojson);
    return group;
  } finally { controller?.dispose(); }
}

test('2048 real catalog3 recommendations and decoded map pass browser admission and preserve every score and anchor', async t => {
  const { f, input, envelope } = fixture();
  const checked = checkCustomCohortPocketCatalog(envelope, input), group = await admittedMap(f, input, checked);
  const before = sha(JSON.stringify({ checked, group })), result = present({ catalog: checked, group });
  assert.equal(checked.pockets.length, V3.groups); assert.equal(checked.recommendation.pockets.length, V3.groups);
  assert.equal(checked.recommendation.stock_composition_v1.reason, 'group_limit');
  assert.equal(result.status, 'available'); assert.equal(result.labels.features.length, V3.groups);
  assert.equal(Object.keys(result.scoresByGroup).length, V3.groups); assert.deepEqual(result.unlabelled_group_ids, []);
  for (const p of checked.recommendation.pockets) {
    const score = result.scoresByGroup[p.id], label = result.labels.features.find(row => row.properties.pocket_id === p.id);
    assert.deepEqual([score.lower, score.upper, score.known_weight_percent],
      [p.similarity.lower, p.similarity.upper, p.similarity.known_weight_percent]);
    const feature = group.parcel_map.geojson.features.find(row => row.id === label.properties.parcel_id);
    assert.equal(feature.properties.account_id, label.properties.account_id);
    assert.ok(feature.geometry.coordinates[0].some(point => JSON.stringify(point) === JSON.stringify(label.geometry.coordinates)));
  }
  assert.equal(sha(JSON.stringify({ checked, group })), before);
  for (const version of [1, 2]) assert.throws(() => present({ catalog: { ...checked, catalog_version: version }, group }));
  assert.throws(() => present({ catalog: { ...checked, recommendation: { ...checked.recommendation,
    pockets: [...checked.recommendation.pockets, checked.recommendation.pockets[0], checked.recommendation.pockets[1]] } }, group }));
  t.diagnostic(JSON.stringify({ groups: V3.groups, output_bytes: Buffer.byteLength(JSON.stringify(result)) }));
});

test('v3 keeps all 2048 maximum-length literals without enlarging v1/v2 output budgets', async t => {
  const { f, input, envelope } = fixture();
  // The actual server may omit its optional recommendation when literal text
  // exceeds that presentation's own unchanged byte budget. Geometry stays usable.
  delete envelope.recommendation;
  envelope.catalog = { ...envelope.catalog, pockets: envelope.catalog.pockets.map(p => ({ ...p, label: 'é'.repeat(256), county: 'é'.repeat(256) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 4_000_000);
  const checked = checkCustomCohortPocketCatalog(envelope, input), group = await admittedMap(f, input, checked);
  const result = present({ catalog: checked, group }), bytes = Buffer.byteLength(JSON.stringify(result));
  assert.equal(result.status, 'available'); assert.equal(result.labels.features.length, 2048);
  assert.ok(bytes > LEGACY.outputBytes); assert.ok(bytes < V3.outputBytes);
  for (const label of result.labels.features) { assert.equal(label.properties.label, 'é'.repeat(256)); assert.equal(label.properties.county, 'é'.repeat(256)); }
  assert.equal(LEGACY.outputBytes, 2_000_000);
  assert.equal(V3.outputBytes, 8_388_608);
  assert.ok(2048 * (3372 + 1) + 2049 * (571 + 1) + 160 < V3.outputBytes,
    'complete escaped feature/score grammar plus separators/envelope fits the v3-only ceiling');
  // Local already-admitted field grammar permits quotes/backslashes too. Exercise
  // their twofold JSON expansion without claiming this larger input is a wire fixture.
  const escaped = { ...checked, pockets: checked.pockets.map(p => ({ ...p, label: '"'.repeat(512), county: '\\'.repeat(512) })) };
  const expanded = present({ catalog: escaped, group }), escapedBytes = Buffer.byteLength(JSON.stringify(expanded));
  assert.equal(expanded.labels.features.length, 2048); assert.ok(escapedBytes > bytes); assert.ok(escapedBytes < V3.outputBytes);
  t.diagnostic(JSON.stringify({ groups: 2048, literal_output_bytes: bytes, escaped_output_bytes: escapedBytes, ceiling: V3.outputBytes }));
});

test('2048 named groups plus unassigned preserve all 2049 recommendation scores and never invent an unassigned anchor', async () => {
  const { f, input, envelope } = fixture(2048, true);
  const checked = checkCustomCohortPocketCatalog(envelope, input), group = await admittedMap(f, input, checked);
  assert.equal(checked.pockets.length, 2048); assert.equal(checked.unassigned.member_count, 1);
  assert.equal(checked.recommendation.pockets.length, 2049);
  const result = present({ catalog: checked, group });
  assert.equal(result.status, 'available'); assert.equal(result.labels.features.length, 2048);
  assert.equal(Object.keys(result.scoresByGroup).length, 2049);
  assert.equal(result.scoresByGroup['discovery:unassigned'].reason, 'unassigned_recorded_group');
  assert.ok(result.labels.features.every(label => label.properties.pocket_id !== 'discovery:unassigned'));
});
