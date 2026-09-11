import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortMapPresentation as build, CUSTOM_COHORT_MAP_PRESENTATION_LIMITS as LIMITS } from '../src/features/neighborhood/customCohortMapPresentation.ts';
import { checkCustomCohortPocketCatalog, selectionFromRecordedGroups } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { createCustomCohortPreviewController } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortParcelMap } from '../../server/src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { presentCustomCohortPreview } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { mapCachedParcelRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';

const copy = value => structuredClone(value), sha = value => createHash('sha256').update(value).digest('hex');
const ALPHA = 'recorded-cad:alpha', BETA = 'recorded-cad:beta', UNKNOWN = 'discovery:unassigned';
const context = { context_id: '7aa588fe-61af-4265-a4d2-611fc0fe9c36', context_revision: '1', context_sha256: 'a'.repeat(64) };
const square = (x = -97, y = 32) => [[x, y], [x + .01, y], [x + .01, y + .01], [x, y + .01], [x, y]];
const feature = (id, account, geometry = { type: 'Polygon', coordinates: [square(-97 + Number(id) / 100)] }) => ({
  type: 'Feature', id: `gis.dcad_parcels:${id}`, properties: { object_id: String(id), account_id: account, selected: account !== 'C' }, geometry });
// Small already-checked presentation projections for geometry edge cases. The
// separate capture/controller test below exercises actual upstream admission.
function fixture() {
  const pockets = [{ id: ALPHA, label: '  Recorded élm / same name  ', county: 'Dallas', account_ids: ['A', 'B'], member_count: 2 },
    { id: BETA, label: '  Recorded élm / same name  ', county: 'Collin', account_ids: ['C'], member_count: 1 }];
  const catalog = { catalog_version: 1, status: 'review_only', binding: { context_ref: copy(context), selection_revision: 1 }, pockets,
    unassigned: { account_ids: ['D'], member_count: 1, reason_counts: [] },
    coverage: { discovery_member_count: 4, assigned_account_count: 3, unassigned_account_count: 1 },
    subject_membership: { account_id: 'A', assigned_pocket_id: ALPHA, status: 'assigned', recorded_label_match_only: true }, limitations: [],
    recommendation: { status: 'recommendation_for_review', pockets: [
      { id: ALPHA, member_count: 2, similarity: { lower: 65.1234, upper: 85.1234, known_weight_percent: 80 } },
      { id: BETA, member_count: 1, similarity: { lower: 30, upper: 70, known_weight_percent: 60 } },
      { id: UNKNOWN, member_count: 1, similarity: { lower: 20, upper: 100, known_weight_percent: 20 } }], limitations: [] } };
  const group = { binding: { accountId: 'A', assignmentFileId: '9007199254740993', contextRef: copy(context), selectionRevision: 99,
    selectionFingerprint: 'b'.repeat(64) }, summary: {}, apply: { status: 'blocked', reasons: ['observations_only'] },
    parcel_map: { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
      geojson: { type: 'FeatureCollection', features: ['A', 'B', 'C', 'D'].map((a, i) => feature(i + 1, a)) },
      counts: { parcels: 4, accounts: 4, selected_accounts: 3, coordinates: 20, geometry_bytes: 512, geojson_bytes: 2048 } } };
  return { group, catalog };
}
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }
function pointOnOriginal(label, original) {
  const parcel = original.group.parcel_map.geojson.features.find(f => f.id === label.properties.parcel_id);
  assert.ok(parcel); assert.equal(parcel.properties.account_id, label.properties.account_id);
  const group = original.catalog.pockets.find(p => p.id === label.properties.pocket_id); assert.ok(group.account_ids.includes(parcel.properties.account_id));
  const exteriors = parcel.geometry.type === 'Polygon' ? [parcel.geometry.coordinates[0]] : parcel.geometry.coordinates.map(p => p[0]);
  assert.ok(exteriors.some(ring => ring.some(point => point[0] === label.geometry.coordinates[0] && point[1] === label.geometry.coordinates[1])));
}

test('exact group means/coverage are copied, not reranked or converted into individual-parcel scores', () => {
  const f = fixture(), before = JSON.stringify(f), result = build(f);
  assert.equal(result.status, 'available'); assert.equal(result.reason, null);
  for (const p of f.catalog.recommendation.pockets) {
    const { status, reason, ...score } = result.scoresByGroup[p.id]; assert.deepEqual(score, p.similarity);
    assert.equal(status, p.id === UNKNOWN ? 'unknown' : 'available'); assert.equal(reason, p.id === UNKNOWN ? 'unassigned_recorded_group' : null);
  }
  assert.equal(result.labels.features.length, 2); assert.deepEqual(result.unlabelled_group_ids, []);
  result.labels.features.forEach(label => pointOnOriginal(label, f)); frozen(result);
  assert.equal(JSON.stringify(f), before); assert.equal(Object.isFrozen(f.group), false);
});
test('selection flags and current revision may change without changing static scores or label geometry', () => {
  const f = fixture(), initial = build(f);
  f.group.binding.selectionRevision++; f.group.binding.selectionFingerprint = 'c'.repeat(64);
  f.group.parcel_map.geojson.features.forEach(p => { p.properties.selected = !p.properties.selected; });
  assert.deepEqual(build(f), initial);
});
for (const mode of ['absent', 'null', 'insufficient']) test(`${mode} recommendation is explicit unknown, never a fabricated score`, () => {
  const f = fixture();
  if (mode === 'absent') delete f.catalog.recommendation;
  else if (mode === 'null') f.catalog.recommendation = null;
  else f.catalog.recommendation.status = 'insufficient_observations';
  const result = build(f); assert.equal(result.labels.features.length, 2);
  for (const [id, s] of Object.entries(result.scoresByGroup)) {
    assert.equal(s.status, 'unknown'); assert.equal(s.reason, id === UNKNOWN ? 'unassigned_recorded_group'
      : mode === 'insufficient' ? 'recommendation_insufficient' : 'recommendation_unavailable');
    if (mode !== 'insufficient') assert.deepEqual([s.lower, s.upper, s.known_weight_percent], [null, null, null]);
    else assert.deepEqual([s.lower, s.upper, s.known_weight_percent], Object.values(f.catalog.recommendation.pockets.find(p => p.id === id).similarity));
  }
});
test('zero known weight stays unknown while an observed zero lower bound remains a real supplied zero', () => {
  const f = fixture(); f.catalog.recommendation.pockets[0].similarity = { lower: 0, upper: 100, known_weight_percent: 0 };
  f.catalog.recommendation.pockets[1].similarity = { lower: 0, upper: 20, known_weight_percent: 80 };
  const result = build(f); assert.equal(result.scoresByGroup[ALPHA].status, 'unknown');
  assert.equal(result.scoresByGroup[ALPHA].reason, 'group_observations_unavailable');
  assert.deepEqual([result.scoresByGroup[ALPHA].lower, result.scoresByGroup[ALPHA].upper, result.scoresByGroup[ALPHA].known_weight_percent], [0, 100, 0]);
  assert.equal(result.scoresByGroup[BETA].status, 'available'); assert.equal(result.scoresByGroup[BETA].lower, 0);
});
test('reordered groups/accounts/features and rotated/reversed exterior rings retain deterministic anchors and IDs', () => {
  const f = fixture(), initial = build(f); f.catalog.pockets.reverse(); f.catalog.pockets.forEach(p => p.account_ids.reverse());
  f.catalog.recommendation.pockets.reverse(); f.group.parcel_map.geojson.features.reverse();
  f.group.parcel_map.geojson.features.forEach(p => { const ring = p.geometry.coordinates[0];
    const rotated = [...ring.slice(2, -1), ...ring.slice(0, 2)].reverse(); p.geometry.coordinates[0] = [...rotated, rotated[0]]; });
  const reordered = build(f); assert.deepEqual(reordered.labels, initial.labels); assert.deepEqual(reordered.scoresByGroup, initial.scoresByGroup);
});
test('same literal labels across counties retain distinct collision-safe recorded-group IDs', () => {
  const f = fixture(), result = build(f), [a, b] = result.labels.features;
  assert.equal(a.properties.label, f.catalog.pockets[0].label); assert.equal(b.properties.label, a.properties.label);
  assert.notEqual(a.properties.county, b.properties.county); assert.notEqual(a.id, b.id);
  assert.equal(a.id, `custom-cohort-label:${a.properties.pocket_id}`);
  assert.equal(b.id, `custom-cohort-label:${b.properties.pocket_id}`);
});
test('long literal names are preserved exactly and never truncated to preview selection labels', () => {
  const f = fixture(); f.catalog.pockets[0].label = 'é'.repeat(256);
  assert.equal(build(f).labels.features[0].properties.label, f.catalog.pockets[0].label);
});
test('concave parcel uses an actual exterior vertex, never its outside bounding-box centroid', () => {
  const f = fixture(), ring = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
  f.group.parcel_map.geojson.features[0].geometry.coordinates = [ring];
  const label = build(f).labels.features[0]; pointOnOriginal(label, f); assert.deepEqual(label.geometry.coordinates, [0, 0]);
  assert.notDeepEqual(label.geometry.coordinates, [1.5, 1.5]);
});
test('holes remain unchanged; no anchor is fabricated at the hole center or chosen from its ring', () => {
  const f = fixture(), outer = square(0, 0), hole = [[.003, .003], [.003, .007], [.007, .007], [.007, .003], [.003, .003]];
  f.group.parcel_map.geojson.features[0].geometry.coordinates = [outer, hole]; const before = JSON.stringify(f);
  const label = build(f).labels.features[0]; pointOnOriginal(label, f); assert.deepEqual(label.geometry.coordinates, [0, 0]);
  assert.equal(hole.some(point => JSON.stringify(point) === JSON.stringify(label.geometry.coordinates)), false); assert.equal(JSON.stringify(f), before);
});
test('disjoint MultiPolygon and multi-parcel groups produce one representative actual-parcel anchor, not a hull', () => {
  const f = fixture(); f.group.parcel_map.geojson.features[0].geometry = { type: 'MultiPolygon', coordinates: [[square(-90)], [square(-100)]] };
  f.group.parcel_map.geojson.features.push(feature('99', 'A', { type: 'Polygon', coordinates: [square(-110)] }));
  const result = build(f), a = result.labels.features.find(l => l.properties.pocket_id === ALPHA);
  assert.equal(result.labels.features.length, 2); assert.equal(a.properties.parcel_id, 'gis.dcad_parcels:1');
  assert.deepEqual(a.geometry.coordinates, [-100, 32]); pointOnOriginal(a, f);
  assert.equal(JSON.stringify(result).includes('Polygon'), false);
});
test('same-looking native account aliases never infer recorded membership', () => {
  const f = fixture(); f.group.parcel_map.geojson.features[0].properties.account_id = 'a';
  const result = build(f); assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'catalog_geometry_mismatch');
  assert.deepEqual(result.scoresByGroup, {}); assert.deepEqual(result.labels.features, []);
});
test('foreign or missing accounts cannot produce a partial labelled catalog', () => {
  for (const mutate of [f => { f.group.parcel_map.geojson.features.pop(); }, f => { f.group.parcel_map.geojson.features[0].properties.account_id = 'FOREIGN'; }]) {
    const f = fixture(); mutate(f); const result = build(f); assert.equal(result.reason, 'catalog_geometry_mismatch');
    assert.deepEqual(result.labels.features, []); assert.deepEqual(result.unlabelled_group_ids, [ALPHA, BETA]);
  }
});
for (const key of ['context_id', 'context_sha256', 'subject_account']) test(`cross-context ${key} never joins scores or parcel identities`, () => {
  const f = fixture(); if (key === 'subject_account') f.group.binding.accountId = 'OTHER';
  else f.group.binding.contextRef[key] = key === 'context_id' ? 'other' : 'f'.repeat(64);
  const result = build(f); assert.equal(result.reason, 'context_mismatch'); assert.deepEqual(result.scoresByGroup, {}); assert.deepEqual(result.labels.features, []);
});
test('unavailable geometry does not erase supplied scores or substitute fallback coordinates', () => {
  const f = fixture(); f.group.parcel_map = { status: 'unavailable', reason: 'missing_parcel_geometry', geojson: null,
    geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary' };
  const result = build(f); assert.equal(result.reason, 'parcel_geometry_unavailable'); assert.deepEqual(result.unlabelled_group_ids, [ALPHA, BETA]);
  assert.deepEqual(result.labels.features, []); assert.equal(result.scoresByGroup[ALPHA].lower, 65.1234);
});
test('empty named groups remain explicit and unassigned accounts gain no invented county or named anchor', () => {
  const f = fixture(); f.catalog.pockets.push({ id: 'recorded-cad:empty', label: 'Empty', county: 'Dallas', account_ids: [], member_count: 0 });
  f.catalog.recommendation.pockets.push({ id: 'recorded-cad:empty', member_count: 0, similarity: { lower: null, upper: null, known_weight_percent: null } });
  const result = build(f); assert.equal(result.scoresByGroup['recorded-cad:empty'].reason, 'empty_group');
  assert.deepEqual(result.unlabelled_group_ids, ['recorded-cad:empty']); assert.equal(result.labels.features.some(l => l.properties.account_id === 'D'), false);
});
test('incomplete all-unassigned catalog stays useful but cannot invent named groups or similarity', () => {
  const f = fixture(); f.catalog.status = 'incomplete'; f.catalog.pockets = []; f.catalog.unassigned.account_ids = ['A', 'B', 'C', 'D'];
  f.catalog.unassigned.member_count = 4; f.catalog.coverage.assigned_account_count = 0; f.catalog.coverage.unassigned_account_count = 4; f.catalog.recommendation = null;
  const result = build(f); assert.equal(result.status, 'available'); assert.deepEqual(result.labels.features, []);
  assert.deepEqual(Object.keys(result.scoresByGroup), [UNKNOWN]); assert.equal(result.scoresByGroup[UNKNOWN].lower, null);
});
const invalid = {
  'NaN score': f => { f.catalog.recommendation.pockets[0].similarity.lower = NaN; },
  'infinite score': f => { f.catalog.recommendation.pockets[0].similarity.upper = Infinity; },
  'negative coverage': f => { f.catalog.recommendation.pockets[0].similarity.known_weight_percent = -1; },
  'contradictory bounds': f => { f.catalog.recommendation.pockets[0].similarity.upper = 50; },
  'missing score group': f => { f.catalog.recommendation.pockets.pop(); },
  'extra score group': f => { f.catalog.recommendation.pockets.push({ id: 'foreign', member_count: 1, similarity: {} }); },
  'duplicate score group': f => { f.catalog.recommendation.pockets.push(copy(f.catalog.recommendation.pockets[0])); },
  'score denominator': f => { f.catalog.recommendation.pockets[0].member_count = 1; },
  'duplicate account membership': f => { f.catalog.pockets[0].account_ids[1] = 'A'; },
  'catalog denominator': f => { f.catalog.coverage.discovery_member_count = 3; },
  'duplicate parcel': f => { f.group.parcel_map.geojson.features.push(copy(f.group.parcel_map.geojson.features[0])); },
  'nonfinite longitude': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates[0][1][0] = Infinity; },
  'NaN latitude': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates[0][1][1] = NaN; },
  'out of range': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates[0][1][0] = 181; },
  'unclosed ring': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates[0].pop(); },
  'extra point dimension': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates[0][0].push(0); },
  'empty polygon': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates = []; },
  'unsupported line': f => { f.group.parcel_map.geojson.features[0].geometry.type = 'LineString'; },
  'bad inner hole': f => { f.group.parcel_map.geojson.features[0].geometry.coordinates.push([[1, 2], [2, 3]]); },
  'overlong label UTF8': f => { f.catalog.pockets[0].label = 'é'.repeat(257); },
};
for (const [name, mutate] of Object.entries(invalid)) test(`invalid ${name} fails closed without source text`, () => {
  const f = fixture(); mutate(f); assert.throws(() => build(f), { name: 'TypeError', message: 'invalid_custom_cohort_map_presentation' });
});
test('membership, geometry and output work are bounded; no clipped group prefix is returned', () => {
  const f = fixture(); f.catalog.pockets = Array.from({ length: LIMITS.groups + 1 }, (_, i) => ({ id: `recorded-cad:${i}`, label: 'N', county: 'D', account_ids: [], member_count: 0 }));
  assert.throws(() => build(f));
  const g = fixture(); g.group.parcel_map.geojson.features = Array(LIMITS.parcels + 1).fill(g.group.parcel_map.geojson.features[0]); assert.throws(() => build(g));
  const c = fixture(); c.group.parcel_map.geojson.features[0].geometry.coordinates = [Array.from({ length: LIMITS.coordinates + 1 }, () => [1, 2])]; assert.throws(() => build(c));
  const largest = fixture(); largest.catalog.pockets = Array.from({ length: 128 }, (_, i) => ({ id: `recorded-cad:${i}`, label: 'é'.repeat(256),
    county: 'é'.repeat(256), account_ids: [`A${i}`], member_count: 1 })); largest.catalog.recommendation = null;
  largest.catalog.unassigned = { account_ids: [], member_count: 0 }; largest.catalog.coverage = { discovery_member_count: 128, assigned_account_count: 128, unassigned_account_count: 0 };
  largest.group.parcel_map.geojson.features = largest.catalog.pockets.map((p, i) => feature(i + 1, p.account_ids[0]));
  const result = build(largest); assert.equal(result.labels.features.length, 128); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.outputBytes);
});

test('v2 labels all1024 long recorded names on exact parcels; v1 and oversized catalogs cannot bypass their bounds', () => {
  const f = fixture(); f.catalog.catalog_version = 2; f.catalog.recommendation = null;
  f.catalog.pockets = Array.from({ length: 1024 }, (_, i) => ({ id: `recorded-cad:${i.toString(16).padStart(64, '0')}`,
    label: 'é'.repeat(256), county: 'é'.repeat(256), account_ids: [`A${i}`], member_count: 1 }));
  f.catalog.unassigned = { account_ids: [], member_count: 0 };
  f.catalog.coverage = { discovery_member_count: 1024, assigned_account_count: 1024, unassigned_account_count: 0 };
  f.group.parcel_map.geojson.features = f.catalog.pockets.map((p, i) => feature(i + 1, p.account_ids[0]));
  const before = JSON.stringify(f.group.parcel_map.geojson), result = build(f);
  assert.equal(result.status, 'available'); assert.equal(result.labels.features.length, 1024);
  assert.equal(result.unlabelled_group_ids.length, 0); result.labels.features.forEach(l => pointOnOriginal(l, f));
  assert.equal(JSON.stringify(f.group.parcel_map.geojson), before);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 512000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.outputBytes);
  assert.ok(Object.values(result.scoresByGroup).every(s => s.status === 'unknown'));
  assert.throws(() => build({ ...f, catalog: { ...f.catalog, catalog_version: 1 } }));
  f.catalog.pockets.push({ ...f.catalog.pockets[0], id: 'recorded-cad:extra' }); assert.throws(() => build(f));
});
test('accessors in consumed fields or array elements are not executed', () => {
  for (const mutate of [f => Object.defineProperty(f.catalog.pockets[0], 'label', { enumerable: true, get() { assert.fail('getter executed'); } }),
    f => Object.defineProperty(f.group.parcel_map.geojson.features[0].geometry.coordinates[0], '0', { enumerable: true, get() { assert.fail('getter executed'); } })]) {
    const f = fixture(); mutate(f); assert.throws(() => build(f), { message: 'invalid_custom_cohort_map_presentation' });
  }
});
test('actual EWKB mapper and parcel decoder preserve original holes for label anchors', () => {
  const f = fixture(), ids = ['A', 'B', 'C', 'D'];
  const uint = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const pair = point => { const b = Buffer.alloc(16); b.writeDoubleLE(point[0]); b.writeDoubleLE(point[1], 8); return b; };
  const records = [], parcels = [], expected = new Map();
  for (const [i, account] of ids.entries()) {
    const id = String(i + 1), rings = [square(-97 + i / 100), square(-96.997 + i / 100, 32.003).map(([x, y]) => [x, y])];
    // Smaller inner ring, separately retained; this test does not claim native topology validation.
    rings[1] = [[-96.997 + i / 100, 32.003], [-96.995 + i / 100, 32.003], [-96.995 + i / 100, 32.005], [-96.997 + i / 100, 32.003]];
    const bytes = Buffer.concat([Buffer.from([1]), uint(0x20000003), uint(4326), uint(rings.length),
      ...rings.flatMap(ring => [uint(ring.length), ...ring.map(pair)])]);
    records.push({ record_id: `parcel:${id}`, data: mapCachedParcelRow({ object_id: id, account_id: account,
      source_record_hash: 'a'.repeat(64), stored_geometry_ewkb: bytes.toString('hex') }) });
    parcels.push({ object_id: id, account_id: account, source_record_hash: 'a'.repeat(64), geometry_sha256: sha(bytes) }); expected.set(id, rings);
  }
  const retained_inputs = { spatial: { status: 'captured', query_complete: true, account_ids: ids, parcels },
    acquisition: { capture_result: { status: 'captured', query_complete: true, source_capture: { status: 'ready',
      sources: [{ payload: { projection: { definition: { role: 'parcels' } }, records } }] } } } };
  const map = buildCustomCohortParcelMap({ retained_inputs, selected_account_ids: ['A', 'B', 'D'] });
  assert.equal(map.status, 'available'); f.group.parcel_map = map;
  for (const feature of map.geojson.features) assert.deepEqual(feature.geometry.coordinates, expected.get(feature.properties.object_id));
  const result = build(f); assert.equal(result.status, 'available'); assert.equal(result.labels.features.length, 2);
  result.labels.features.forEach(label => pointOnOriginal(label, f));
});

test('actual retained capture/catalog/controller admission preserves unavailable geometry and unchanged recommendations', { timeout: 10000 }, async () => {
  const f = await decisionEvidenceFixture(), context = f.input.expected.context_ref, retained = f.input.retained_inputs;
  const expected = { context_ref: context, selection_revision: 7 };
  const rawCatalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const recommendation = presentCustomCohortPocketRecommendation({ expected, catalog: rawCatalog,
    recommendation: buildCustomCohortPocketRecommendation({ context_ref: context, retained_inputs: retained,
      selection: { revision: 7, included_recorded_group_ids: [] } }) });
  const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    contextRef: context, selection: { revision: 7, pockets: [] } };
  const catalog = checkCustomCohortPocketCatalog({ status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: context, selection_revision: 7, subject_freshness: 'matched', catalog: rawCatalog, recommendation, apply: { status: 'blocked' } }, input);
  const selected = { ...input, selection: selectionFromRecordedGroups(catalog, catalog.pockets.map(p => p.id), 8) };
  const preview = buildCustomCohortObservationPreview({ context_ref: context, retained_inputs: retained, selection: selected.selection });
  const summary = presentCustomCohortPreview({ preview, expected: { context_ref: context, selection_revision: 8 } });
  const map = buildCustomCohortParcelMap({ retained_inputs: retained, selected_account_ids: selected.selection.pockets.flatMap(p => p.account_ids) });
  let controller;
  const group = await new Promise((resolve, reject) => {
    controller = createCustomCohortPreviewController({ fingerprint: async json => sha(json),
      timer: { set(fn, ms) { return setTimeout(fn, ms === 250 ? 0 : ms); }, clear(handle) { clearTimeout(handle); } },
      transport: async () => ({ status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
        context_ref: context, selection_revision: 8, subject_freshness: 'matched', summary, parcel_map: map,
        apply: { status: 'blocked', reasons: ['observation_preview_only'] } }),
      onChange(state) { if (state.status === 'ready') resolve(state.group); if (state.status === 'failed') reject(new Error(state.error)); } });
    controller.setSelection(selected);
  });
  controller.dispose(); const actual = { catalog, group }, result = build(actual);
  // The immutable shared fixture intentionally captures opaque010203 geometry;
  // no relabeling or fallback polygon may make its actual decoder result usable.
  assert.equal(map.status, 'unavailable'); assert.equal(map.reason, 'invalid_geometry');
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'parcel_geometry_unavailable'); assert.equal(result.labels.features.length, 0);
  assert.deepEqual(result.unlabelled_group_ids, catalog.pockets.map(p => p.id).sort());
  for (const p of catalog.recommendation.pockets) {
    const mapped = result.scoresByGroup[p.id]; assert.deepEqual([mapped.lower, mapped.upper, mapped.known_weight_percent],
      [p.similarity.lower, p.similarity.upper, p.similarity.known_weight_percent]);
  }
  assert.equal(group.binding.selectionRevision, 8); assert.equal(catalog.binding.selection_revision, 7); frozen(result);
});
