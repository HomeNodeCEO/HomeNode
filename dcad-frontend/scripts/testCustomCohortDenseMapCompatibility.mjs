import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildFrozenCadSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCombinedEvidenceParcelRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappingsV5.js';
import { DENSE_CAD_CACHE_READER_LIMITS } from '../../server/src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { buildCustomCohortParcelMap } from '../../server/src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { createCustomCohortPreviewTransport, createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { createCustomCohortPreviewController } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { checkCustomCohortPocketCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { buildCustomCohortMapPresentation } from '../src/features/neighborhood/customCohortMapPresentation.ts';
import { buildCustomCohortSubdivisionFamilies } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { buildCustomCohortSubdivisionFamilyLocationReview } from '../src/features/neighborhood/customCohortSubdivisionLocationReview.ts';

const sha = value => createHash('sha256').update(value).digest('hex');
const context = { context_id: '30000000-0000-4000-8000-000000000005', context_revision: '1', context_sha256: 'a'.repeat(64) };
const ids = ['A', 'B'];
const pocket = (account, index) => ({ id: `recorded-cad:${String(index + 1).padStart(64, '0')}`,
  label: `Synthetic Park ${index + 1}`, county: 'Dallas', account_ids: [account], member_count: 1 });
const pockets = ids.map(pocket);
const request = (revision = 1, included = ids) => ({ accountId: 'A', assignmentFileId: '17', contextRef: context,
  selection: { revision, pockets: pockets.filter(p => included.includes(p.account_ids[0]))
    .map(({ id, label, account_ids }) => ({ id, label, account_ids })) } });
const fingerprint = input => sha(JSON.stringify({ pockets: [...input.selection.pockets].map(p => ({
  account_ids: [...p.account_ids].sort(), id: p.id, label: p.label })).sort((a, b) => a.id.localeCompare(b.id)),
revision: input.selection.revision }));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Actual mapping5 and dense immutable chunk construction, but synthetic public
// geometry only: this is not a SQL/topology/rights/retention admission fixture.
async function denseFixture() {
  const scope = { organization_id: '30000000-0000-4000-8000-000000000001',
    appraisal_case_id: '30000000-0000-4000-8000-000000000002',
    subject_snapshot_id: '30000000-0000-4000-8000-000000000003', account_id: 'A' };
  const records = [], roster = [], expected = new Map();
  for (let index = 0; index < 200; index++) {
    const count = 3500, bytes = Buffer.alloc(17 + count * 16), id = String(index + 1), account = ids[index % 2];
    bytes[0] = 1; bytes.writeUInt32LE(0x20000003, 1); bytes.writeUInt32LE(4326, 5);
    bytes.writeUInt32LE(1, 9); bytes.writeUInt32LE(count, 13);
    for (let i = 0; i < count; i++) {
      const angle = (i === count - 1 ? 0 : i) * 2 * Math.PI / (count - 1);
      const point = [-96.71234567890123 + index * .0002 + Math.cos(angle) * .0001,
        32.81234567890123 + Math.sin(angle) * .0001];
      bytes.writeDoubleLE(point[0], 17 + i * 16); bytes.writeDoubleLE(point[1], 25 + i * 16);
    }
    const raw = { object_id: id, account_id: account, source_record_hash: sha(`synthetic:${id}`),
      stored_geometry_ewkb: bytes.toString('hex'), class_code: 'A1', class_description: 'Single family',
      use_description: 'Residential', structure_type: null, built_up: true };
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= DENSE_CAD_CACHE_READER_LIMITS.row_bytes);
    records.push({ record_id: `parcel:${id}`, data: mapCombinedEvidenceParcelRow(raw) });
    roster.push({ object_id: id, account_id: account, source_record_hash: raw.source_record_hash, geometry_sha256: sha(bytes) });
    expected.set(id, bytes);
  }
  const now = '2026-09-19T12:00:00.000Z';
  const capture = await buildFrozenCadSourceCaptures(freeze({ scope, captures: [{
    upstream: { id: 'local-cache:parcels', key: 'parcels', state: 'populated', complete: true,
      revision: 'synthetic-dense-map-v2', content_sha256: 'b'.repeat(64), captured_at: now,
      visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: 'local-cache-parcels', provider: 'Synthetic dense geometry', revision: 'synthetic-dense-map-v2',
      valid_from: null, valid_to: null, observed_at: now, historical_availability: 'unknown' },
    projection: { id: 'cache-parcels', revision: 'synthetic-dense-map-v2', definition: { role: 'parcels', mapping_version: 5 },
      complete: true, input_row_count: records.length, output_record_count: records.length }, records,
  }] }));
  assert.equal(capture.status, 'ready');
  assert.ok(capture.sources.length > 1, 'real bounded chunk construction');
  assert.ok(capture.sources.every(s => s.payload.projection.definition.mapping_version === 5));
  const retained_inputs = { spatial: { status: 'captured', query_complete: true, account_ids: ids, parcels: roster },
    acquisition: { compact_metadata_json: JSON.stringify({ reader_version: 'local-capture-v3', mapping_version: 5,
      limits: DENSE_CAD_CACHE_READER_LIMITS }), capture_result: { status: 'captured', query_complete: true, source_capture: capture } } };
  return { retained_inputs, expected };
}

function envelope(input, parcel_map) {
  const count = new Set(input.selection.pockets.flatMap(p => p.account_ids)).size;
  return { status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: context, selection_revision: input.selection.revision, subject_freshness: 'matched',
    summary: { presentation_version: 1, preview_version: 1, status: 'observations_only', members_included: false,
      contents: 'population_summaries_only', binding: { context_ref: context,
        selection_revision: input.selection.revision, selection_sha256: fingerprint(input) },
      all: { stock: { member_count: 2 } }, selected: { stock: { member_count: count } },
      apply: { status: 'blocked', reasons: ['observation_preview_only'] } }, parcel_map,
    apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
}
function catalogFor(input) {
  const catalog = { catalog_version: 2, status: 'review_only', binding: { context_ref: context, selection_revision: 1 },
    pockets: pockets.map(p => ({ ...p, disposition: 'needs_review' })),
    unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
    coverage: { discovery_member_count: 2, assigned_account_count: 2, unassigned_account_count: 0 },
    subject_membership: { account_id: 'A', assigned_pocket_id: pockets[0].id, status: 'recorded_label_matched', recorded_label_match_only: true },
    limitations: [], apply: { status: 'blocked' } };
  return checkCustomCohortPocketCatalog({ status: 'catalog', target: { account_id: 'A', assignment_file_id: '17' },
    context_ref: context, selection_revision: 1, subject_freshness: 'matched', catalog, apply: { status: 'blocked' } }, input);
}
function controllerHarness() {
  const calls = [], timers = new Map(); let next = 0;
  const controller = createCustomCohortPreviewController({ fingerprint: async text => sha(text),
    timer: { set(callback, delay) { const key = ++next; timers.set(key, { callback, delay }); return key; }, clear(key) { timers.delete(key); } },
    transport: (input, { signal }) => new Promise(resolve => calls.push({ input, signal, resolve })) });
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { controller, calls, async start(input) {
    controller.setSelection(input);
    for (const [id, timer] of [...timers]) if (timer.delay === 250) { timers.delete(id); timer.callback(); }
    await drain();
  }, async complete(index, value) { calls[index].resolve(value); await drain(); } };
}

test('mapping5 dense geometry beyond500k/24MB survives complete producer, transport, controller and presentation without changing selection',
  { timeout: 90_000 }, async t => {
    const started = performance.now();
    const fixture = await denseFixture();
    const map = buildCustomCohortParcelMap({ retained_inputs: fixture.retained_inputs, selected_account_ids: ids });
    assert.equal(map.status, 'available'); assert.equal(map.counts.coordinates, 700_000);
    assert.ok(map.counts.geojson_bytes > 24_000_000 && map.counts.geojson_bytes < 32_000_000);
    assert.ok(map.counts.geometry_bytes <= 16_000_000);
    const original = sha(JSON.stringify(map.geojson)), h = controllerHarness(); t.after(() => h.controller.dispose());
    const first = request(); await h.start(first);
    const value = envelope(h.calls[0].input, map), wire = JSON.stringify(value);
    assert.ok(Buffer.byteLength(wire) > 24_000_000 && Buffer.byteLength(wire) < 35_000_000);
    t.diagnostic(JSON.stringify({ coordinates: map.counts.coordinates, geojson_bytes: map.counts.geojson_bytes,
      preview_bytes: Buffer.byteLength(wire), source_chunks: fixture.retained_inputs.acquisition.capture_result.source_capture.sources.length }));
    const transport = createCustomCohortPreviewTransport({ urlFor: p => p,
      request: async () => new Response(wire, { headers: { 'content-type': 'application/json' } }) });
    await h.complete(0, await transport(h.calls[0].input, { signal: h.calls[0].signal }));
    const group = h.controller.getState().group; assert.equal(h.controller.getState().status, 'ready');
    assert.equal(group.parcel_map.counts.selected_accounts, 2); assert.equal(group.binding.selectionFingerprint, fingerprint(first));
    assert.equal(sha(JSON.stringify(group.parcel_map.geojson)), original);
    for (const feature of group.parcel_map.geojson.features) {
      const bytes = fixture.expected.get(feature.properties.object_id);
      assert.equal(feature.geometry.type, 'Polygon'); assert.equal(feature.geometry.coordinates.length, 1);
      const ring = feature.geometry.coordinates[0]; assert.equal(ring.length, bytes.readUInt32LE(13));
      for (let i = 0; i < ring.length; i++) {
        assert.deepEqual(ring[i], [bytes.readDoubleLE(17 + i * 16), bytes.readDoubleLE(25 + i * 16)]);
      }
      assert.equal(feature.properties.selected, true);
    }
    const catalog = catalogFor(first), presentation = buildCustomCohortMapPresentation({ catalog, group });
    assert.equal(presentation.status, 'available'); assert.equal(presentation.labels.features.length, 2);
    const families = buildCustomCohortSubdivisionFamilies(catalog), familyId = families.family_id_by_pocket_id[pockets[0].id];
    const location = buildCustomCohortSubdivisionFamilyLocationReview({ families, familyId, catalog, group });
    assert.equal(location.status, 'available'); assert.equal(location.represented_account_count, 2);
    assert.equal(location.child_extents.reduce((sum, child) => sum + child.parcel_count, 0), 200);
    for (const feature of group.parcel_map.geojson.features) for (const [x, y] of feature.geometry.coordinates[0]) {
      assert.ok(x >= location.combined_extent.west && x <= location.combined_extent.east);
      assert.ok(y >= location.combined_extent.south && y <= location.combined_extent.north);
    }
    const next = request(2, ['B']); await h.start(next); assert.equal(h.calls[1].input.include_map, false);
    await h.complete(1, envelope(h.calls[1].input, { status: 'omitted', reason: 'geometry_not_requested' }));
    const changed = h.controller.getState().group; assert.equal(h.controller.getState().status, 'ready');
    assert.equal(changed.summary.selected.stock.member_count, 1); assert.equal(changed.parcel_map.counts.selected_accounts, 1);
    assert.equal(changed.parcel_map.counts.geojson_bytes, Buffer.byteLength(JSON.stringify(changed.parcel_map.geojson)));
    for (let i = 0; i < changed.parcel_map.geojson.features.length; i++) {
      const feature = changed.parcel_map.geojson.features[i];
      assert.equal(feature.geometry, group.parcel_map.geojson.features[i].geometry);
      assert.equal(feature.properties.selected, feature.properties.account_id === 'B');
    }
    assert.deepEqual(buildCustomCohortMapPresentation({ catalog, group: changed }), presentation);
    assert.deepEqual(buildCustomCohortSubdivisionFamilyLocationReview({ families, familyId, catalog, group: changed }), location);
    assert.equal(sha(JSON.stringify(map.geojson)), original, 'source map not mutated by selection changes');

    // Same real map through the separate catalog+opening transport, not merely
    // a declared Content-Length; ordinary catalog still has its smaller cap.
    const opening = createCustomCohortJsonTransport({ urlFor: p => p, request: async () =>
      new Response(`{"initial_preview":${wire}}`, { headers: { 'content-type': 'application/json' } }) });
    const opened = await opening('A', 'catalog', { initial_preview_mode: 'all_catalog_groups' }, { signal: new AbortController().signal });
    assert.equal(sha(JSON.stringify(opened.initial_preview.parcel_map.geojson)), original);
    await assert.rejects(opening('A', 'catalog', {}, { signal: new AbortController().signal }), /too large/);
    // This one synthetic process holds server construction AND multiple browser
    // wire/controller copies. Its peak is not a backend-only memory forecast.
    t.diagnostic(JSON.stringify({ fixture_elapsed_ms: Math.round(performance.now() - started),
      combined_test_process_peak_rss_kib: process.resourceUsage().maxRSS }));
  });

test('dense consumers reject over-limit declarations rather than retaining a partial map', async () => {
  for (const badCounts of [{ coordinates: 1_000_001 }, { geojson_bytes: 32_000_001 }]) {
    const h = controllerHarness();
    try {
      await h.start(request());
      const features = ids.map((account, index) => ({ type: 'Feature', id: `gis.dcad_parcels:${index + 1}`,
        properties: { object_id: String(index + 1), account_id: account, selected: true },
        geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 33], [-97, 32]]] } }));
      const map = { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
        geojson: { type: 'FeatureCollection', features }, counts: { parcels: 2, accounts: 2, selected_accounts: 2,
          coordinates: 8, geometry_bytes: 162, geojson_bytes: 512, ...badCounts } };
      await h.complete(0, envelope(h.calls[0].input, map));
      assert.equal(h.controller.getState().error, 'invalid_response'); assert.equal(h.controller.getState().group, null);
    } finally { h.controller.dispose(); }
  }
});

test('actual overmillion coordinate walk fails closed in controller, labels and location even with small coordinate text', { timeout: 30_000 }, async t => {
  const h = controllerHarness(); t.after(() => h.controller.dispose()); await h.start(request());
  const features = ids.map((account, index) => ({ type: 'Feature', id: `gis.dcad_parcels:${index + 1}`,
    properties: { object_id: String(index + 1), account_id: account, selected: true },
    geometry: { type: 'Polygon', coordinates: [index ? [[1, 2], [2, 2], [2, 3], [1, 2]]
      : Array.from({ length: 1_000_001 }, () => [1, 2])] } }));
  const geojson = { type: 'FeatureCollection', features };
  const map = { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
    geojson, counts: { parcels: 2, accounts: 2, selected_accounts: 2, coordinates: 1_000_005,
      geometry_bytes: 16_000_000, geojson_bytes: Buffer.byteLength(JSON.stringify(geojson)) } };
  assert.ok(map.counts.geojson_bytes < 32_000_000, 'coordinate bound is independent of byte bound');
  await h.complete(0, envelope(h.calls[0].input, map));
  assert.equal(h.controller.getState().error, 'invalid_response'); assert.equal(h.controller.getState().group, null);
  const catalog = catalogFor(request()), group = { binding: { accountId: 'A', assignmentFileId: '17', contextRef: context,
    selectionRevision: 1, selectionFingerprint: fingerprint(request()) }, parcel_map: map };
  assert.throws(() => buildCustomCohortMapPresentation({ catalog, group }), /invalid_custom_cohort_map_presentation/);
  const families = buildCustomCohortSubdivisionFamilies(catalog), familyId = families.family_id_by_pocket_id[pockets[0].id];
  // A dishonest count cannot bypass the advisory's independent actual walk.
  group.parcel_map = { ...map, counts: { ...map.counts, coordinates: 1_000_000 } };
  const location = buildCustomCohortSubdivisionFamilyLocationReview({ families, familyId, catalog, group });
  assert.equal(location.status, 'unavailable'); assert.equal(location.reason, 'capacity_exceeded');
  assert.equal(location.combined_extent, null);
});
