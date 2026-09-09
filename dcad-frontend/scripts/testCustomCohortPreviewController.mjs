import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCustomCohortPreviewController } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCustomCohortParcelMap } from '../../server/src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const semantics = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
const clone = value => structuredClone(value);
const context = { context_id: '71fe3e95-778b-42a8-bf4c-5dfc96de3bd7', context_revision: '1', context_sha256: 'a'.repeat(64) };
const pocket = (id = 'p1', accounts = ['A']) => ({ id, label: `Pocket ${id}`, account_ids: accounts });
const input = (revision = 1, pockets = [pocket()]) => ({ accountId: 'SUBJECT', assignmentFileId: '9007199254740993',
  contextRef: clone(context), selection: { revision, pockets } });
const selectionHash = request => hash(JSON.stringify({ pockets: [...request.selection.pockets].map(p => ({
  account_ids: [...p.account_ids].sort(), id: p.id, label: p.label,
})).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), revision: request.selection.revision }));
const selected = request => new Set(request.selection.pockets.flatMap(p => p.account_ids));
const features = chosen => ['A', 'B'].map((id, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
  properties: { object_id: String(i + 1), account_id: id, selected: chosen.has(id) },
  geometry: { type: 'Polygon', coordinates: [[[-97 + i / 10, 32], [-96.99 + i / 10, 32],
    [-96.99 + i / 10, 32.01], [-97 + i / 10, 32]]] } }));
function response(request, { map = request.include_map ? 'available' : 'omitted' } = {}) {
  const chosen = selected(request), geojson = { type: 'FeatureCollection', features: features(chosen) };
  return { status: 'preview', target: { account_id: request.accountId, assignment_file_id: request.assignmentFileId },
    context_ref: clone(request.contextRef), selection_revision: request.selection.revision, subject_freshness: 'matched',
    summary: { presentation_version: 1, preview_version: 1, status: 'observations_only', members_included: false,
      contents: 'population_summaries_only', binding: { context_ref: clone(request.contextRef),
        selection_revision: request.selection.revision, selection_sha256: selectionHash(request) },
      all: { stock: { member_count: 2 } }, selected: { stock: { member_count: chosen.size } },
      apply: { status: 'blocked', reasons: ['observation_preview_only'] } },
    parcel_map: map === 'omitted' ? { status: 'omitted', reason: 'geometry_not_requested' }
      : map === 'unavailable' ? { status: 'unavailable', reason: 'missing_parcel_geometry', geojson: null, geometry_semantics: semantics }
        : { status: 'available', geometry_semantics: semantics, geojson,
          counts: { parcels: 2, accounts: 2, selected_accounts: chosen.size, coordinates: 8, geometry_bytes: 1024,
            geojson_bytes: Buffer.byteLength(JSON.stringify(geojson)) } },
    apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(options = {}) {
  let nextTimer = 0; const timers = new Map(), calls = [], states = [];
  const timer = { set(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clear(id) { timers.delete(id); } };
  const controller = createCustomCohortPreviewController({ timer, fingerprint: async value => hash(value),
    transport: (request, { signal }) => new Promise((resolve, reject) => calls.push({ request, signal, resolve, reject })),
    onChange: state => states.push(state), ...options });
  return { controller, calls, states, timers,
    async tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(t => t.callback()); await drain(); },
    async complete(index, payload = response(calls[index].request)) { calls[index].resolve(payload); await drain(); },
    async fail(index, error = new Error('private server error')) { calls[index].reject(error); await drain(); },
  };
}

test('rapid pocket edits debounce into one request for the settled, detached selection', async () => {
  const h = harness(), last = input(3, [pocket('z', ['B']), pocket('a', ['A'])]);
  h.controller.setSelection(input()); h.controller.setSelection(input(2)); h.controller.setSelection(last);
  last.selection.pockets[0].account_ids.push('MUTATED');
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 250);
  await h.tick(); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].request.selection.pockets.map(p => p.id), ['a', 'z']);
  assert.deepEqual(h.calls[0].request.selection.pockets[1].account_ids, ['B']);
  assert.equal(h.calls[0].request.include_map, true);
  assert.ok(Object.isFrozen(h.calls[0].request.selection.pockets[0].account_ids));
});
test('a successful response replaces the statistics and parcel map as one immutable group', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick();
  const result = response(h.calls[0].request); await h.complete(0, result);
  const state = h.controller.getState(); assert.equal(state.status, 'ready'); assert.equal(state.freshness, 'current');
  assert.equal(state.group.summary.selected.stock.member_count, 1);
  assert.equal(state.group.parcel_map.geojson.features[0].properties.selected, true);
  result.summary.selected.stock.member_count = 99; result.parcel_map.geojson.features[0].properties.selected = false;
  assert.equal(state.group.summary.selected.stock.member_count, 1);
  assert.equal(state.group.parcel_map.geojson.features[0].properties.selected, true);
  assert.ok(Object.isFrozen(state.group.summary.selected.stock)); assert.ok(Object.isFrozen(state.group.parcel_map.geojson.features));
});
test('equivalent selection ordering and repeated renders do not restart pending or completed requests', async () => {
  const h = harness(); h.controller.setSelection(input(1, [pocket('b', ['B', 'A']), pocket('a', [])]));
  h.controller.setSelection(input(1, [pocket('a', []), pocket('b', ['A', 'B'])])); await h.tick();
  h.controller.setSelection(input(1, [pocket('a', []), pocket('b', ['A', 'B'])]));
  await h.complete(0); h.controller.setSelection(input(1, [pocket('a', []), pocket('b', ['A', 'B'])]));
  await h.tick(); assert.equal(h.calls.length, 1); assert.equal(h.controller.getState().status, 'ready');
});
test('explicit empty selection stays empty, reuses geometry, and never shows new flags with old statistics', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
  const prior = h.controller.getState().group;
  h.controller.setSelection(input(2, [])); assert.equal(h.controller.getState().freshness, 'stale');
  assert.equal(h.controller.getState().group, prior); assert.equal(prior.summary.selected.stock.member_count, 1);
  await h.tick(); assert.equal(h.calls[1].request.include_map, false); assert.deepEqual(h.calls[1].request.selection.pockets, []);
  await h.complete(1); const current = h.controller.getState().group;
  assert.equal(current.summary.selected.stock.member_count, 0); assert.equal(current.parcel_map.geojson.features.length, 2);
  assert.ok(current.parcel_map.geojson.features.every(f => f.properties.selected === false));
  assert.equal(current.parcel_map.counts.selected_accounts, 0);
  assert.equal(current.parcel_map.counts.geojson_bytes, Buffer.byteLength(JSON.stringify(current.parcel_map.geojson)));
  assert.equal(prior.parcel_map.geojson.features[0].properties.selected, true);
  assert.equal(current.parcel_map.geojson.features[0].geometry, prior.parcel_map.geojson.features[0].geometry);
});
test('overlapping pockets select each account once for cached geometry', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
  h.controller.setSelection(input(2, [pocket('a', ['A']), pocket('b', ['A', 'B'])])); await h.tick(); await h.complete(1);
  const group = h.controller.getState().group;
  assert.equal(group.summary.selected.stock.member_count, 2); assert.equal(group.parcel_map.counts.selected_accounts, 2);
  assert.ok(group.parcel_map.geojson.features.every(f => f.properties.selected));
  assert.equal(group.parcel_map.counts.geojson_bytes, Buffer.byteLength(JSON.stringify(group.parcel_map.geojson)));
});
for (const change of [v => { v.accountId = 'OTHER'; }, v => { v.assignmentFileId = '2'; },
  v => { v.contextRef.context_id = '71fe3e95-778b-42a8-bf4c-5dfc96de3bd8'; }, v => { v.contextRef.context_sha256 = 'b'.repeat(64); }]) {
  test(`target/context change clears old data and aborts the prior request: ${change}`, async () => {
    const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
    h.controller.setSelection(input(2)); await h.tick(); const changed = input(3); change(changed);
    h.controller.setSelection(changed); assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.controller.getState().group, null);
    await h.tick(); assert.equal(h.calls[2].request.include_map, true);
    await h.complete(1); assert.equal(h.controller.getState().status, 'loading'); assert.equal(h.controller.getState().group, null);
    await h.complete(2); assert.equal(h.controller.getState().group.binding.accountId, changed.accountId);
    assert.equal(h.controller.getState().group.binding.assignmentFileId, changed.assignmentFileId);
  });
}
test('older same-target response or rejection cannot replace the latest accepted group', async () => {
  for (const lateFailure of [false, true]) {
    const h = harness(); h.controller.setSelection(input()); await h.tick();
    h.controller.setSelection(input(2, [pocket('b', ['B'])])); await h.tick(); assert.equal(h.calls[0].signal.aborted, true);
    await h.complete(1); const current = h.controller.getState();
    if (lateFailure) await h.fail(0); else await h.complete(0);
    assert.equal(h.controller.getState(), current); assert.equal(current.group.binding.selectionRevision, 2);
  }
});
test('same revision with a different selection still invalidates the prior operation', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick();
  h.controller.setSelection(input(1, [pocket('p1', ['B'])])); await h.tick(); await h.complete(1); await h.complete(0);
  const group = h.controller.getState().group;
  assert.equal(group.binding.selectionFingerprint, selectionHash(h.calls[1].request));
  assert.equal(group.parcel_map.geojson.features[1].properties.selected, true);
});
test('failed requests preserve only the last coherent group as stale and do not retry on rerender', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
  const prior = h.controller.getState().group; h.controller.setSelection(input(2, [])); await h.tick(); await h.fail(1);
  assert.equal(h.controller.getState().group, prior); assert.equal(h.controller.getState().freshness, 'stale');
  assert.equal(h.controller.getState().error, 'request_failed');
  h.controller.setSelection(input(2, [])); await h.tick(); assert.equal(h.calls.length, 2);
  assert.ok(!JSON.stringify(h.controller.getState()).includes('private server error'));
});
test('changing a selection while SHA-256 is pending prevents the obsolete transport call', async () => {
  const digests = [], h = harness({ fingerprint: value => new Promise(resolve => digests.push({ value, resolve })) });
  h.controller.setSelection(input()); await h.tick(); h.controller.setSelection(input(2)); await h.tick();
  digests[0].resolve(hash(digests[0].value)); await drain(); assert.equal(h.calls.length, 0);
  digests[1].resolve(hash(digests[1].value)); await drain(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.selection.revision, 2);
});
test('fingerprint failure fails once without sending an unbound request', async () => {
  const h = harness({ fingerprint: async () => { throw new Error('crypto unavailable'); } });
  h.controller.setSelection(input()); await h.tick(); assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().status, 'failed'); await h.tick(); assert.equal(h.calls.length, 0);
});
test('the finite request deadline aborts a hung transport, retains stale values, and never retries', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
  const prior = h.controller.getState().group;
  h.controller.setSelection(input(2)); await h.tick();
  assert.equal([...h.timers.values()][0].delay, 65_000); await h.tick();
  assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.controller.getState().error, 'request_timeout');
  assert.equal(h.controller.getState().group, prior); assert.equal(h.controller.getState().freshness, 'stale');
  await h.complete(1); assert.equal(h.controller.getState().error, 'request_timeout');
  h.controller.setSelection(input(2)); await h.tick(); assert.equal(h.calls.length, 2);
});
test('the same deadline covers a stalled digest and does not send a late request', async () => {
  let complete;
  const h = harness({ fingerprint: value => new Promise(resolve => { complete = () => resolve(hash(value)); }) });
  h.controller.setSelection(input()); await h.tick(); await h.tick();
  assert.equal(h.controller.getState().error, 'request_timeout'); complete(); await drain();
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
});
for (const [label, mutate] of [
  ['account', r => { r.target.account_id = 'OTHER'; }], ['assignment', r => { r.target.assignment_file_id = 9007199254740992; }],
  ['context', r => { r.context_ref.context_sha256 = 'b'.repeat(64); }], ['selection revision', r => { r.selection_revision = 2; }],
  ['subject freshness', r => { r.subject_freshness = 'changed'; }], ['summary context', r => { r.summary.binding.context_ref.context_sha256 = 'b'.repeat(64); }],
  ['summary revision', r => { r.summary.binding.selection_revision = 2; }], ['fingerprint', r => { r.summary.binding.selection_sha256 = 'b'.repeat(64); }],
  ['summary version', r => { r.summary.presentation_version = 2; }], ['report Apply', r => { r.apply.status = 'allowed'; }],
  ['summary Apply', r => { r.summary.apply.status = 'allowed'; }], ['member payload', r => { r.summary.members_included = true; }],
  ['missing geometry', r => { r.parcel_map = { status: 'omitted', reason: 'geometry_not_requested' }; }],
  ['map selection', r => { r.parcel_map.geojson.features[1].properties.selected = true; }],
  ['map count', r => { r.parcel_map.counts.selected_accounts = 2; }],
  ['open ring', r => { r.parcel_map.geojson.features[0].geometry.coordinates[0].pop(); }],
  ['unsupported geometry', r => { r.parcel_map.geojson.features[0].geometry.type = 'Point'; }],
  ['summary size', r => { r.summary.extra = 'x'.repeat(2_000_001); }],
]) {
  test(`refuses mismatched/unsupported response ${label} without partial statistics or map`, async () => {
    const h = harness(); h.controller.setSelection(input()); await h.tick();
    const r = response(h.calls[0].request); mutate(r); await h.complete(0, r);
    assert.equal(h.controller.getState().status, 'failed'); assert.equal(h.controller.getState().error, 'invalid_response');
    assert.equal(h.controller.getState().group, null);
  });
}
test('explicit map unavailability does not fall back to an earlier map and next request asks for geometry', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0);
  h.controller.setSelection(input(2)); await h.tick(); await h.complete(1, response(h.calls[1].request, { map: 'unavailable' }));
  assert.equal(h.controller.getState().status, 'ready'); assert.equal(h.controller.getState().group.parcel_map.status, 'unavailable');
  h.controller.setSelection(input(3)); await h.tick(); assert.equal(h.calls[2].request.include_map, true);
});
test('an unavailable first map remains explicitly unavailable with usable observation summaries', async () => {
  const h = harness(); h.controller.setSelection(input()); await h.tick(); await h.complete(0, response(h.calls[0].request, { map: 'unavailable' }));
  assert.equal(h.controller.getState().group.parcel_map.geojson, null);
  assert.equal(h.controller.getState().group.summary.selected.stock.member_count, 1);
});
test('response extensions are bounded and cyclic or accessor-bearing summary objects are rejected', async () => {
  for (const alter of [r => { r.summary.cycle = r.summary; },
    r => { Object.defineProperty(r.summary, 'evil', { enumerable: true, get() { throw new Error('must not read'); } }); },
    r => { r.summary.extra = Array(150_001).fill(0); }]) {
    const h = harness(); h.controller.setSelection(input()); await h.tick(); const r = response(h.calls[0].request); alter(r); await h.complete(0, r);
    assert.equal(h.controller.getState().error, 'invalid_response');
  }
});
test('invalid/new inputs cancel old work and clear old data instead of retaining another file', async () => {
  const invalid = [
    { ...input(), assignmentFileId: 2 }, { ...input(), assignmentFileId: '092' },
    { ...input(), assignmentFileId: '9223372036854775808' }, { ...input(), accountId: '' },
    input(0), input(1, Array.from({ length: 129 }, (_, i) => pocket(String(i)))),
    input(1, [pocket(), pocket()]), input(1, [pocket('p1', ['A', 'A'])]), input(1, [pocket('p1', Array(50_001).fill('A'))]),
    input(1, [pocket('p1', ['A\nB'])]), input(1, Array(1)), input(1, [pocket('p1', Array(1))]),
  ];
  for (const value of invalid) {
    const h = harness(); h.controller.setSelection(input()); await h.tick(); h.controller.setSelection(value);
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.controller.getState().error, 'invalid_input');
    assert.equal(h.controller.getState().group, null); await h.complete(0); assert.equal(h.controller.getState().error, 'invalid_input');
  }
});
test('oversized UTF-8 selection is refused before transport with room left for the HTTP envelope', async () => {
  const accounts = Array.from({ length: 40_000 }, (_, i) => `${String(i).padStart(5, '0')}${'x'.repeat(95)}`);
  const h = harness(); h.controller.setSelection(input(1, [pocket('large', accounts)])); await h.tick();
  assert.equal(h.controller.getState().error, 'invalid_input'); assert.equal(h.calls.length, 0);
});
test('reset and disposal cancel pending timers and active requests without later state writes', async () => {
  const h = harness(); h.controller.setSelection(input()); h.controller.setSelection(null); await h.tick(); assert.equal(h.calls.length, 0);
  h.controller.setSelection(input()); await h.tick(); h.controller.dispose(); const terminal = h.controller.getState();
  assert.equal(h.calls[0].signal.aborted, true); await h.complete(0); assert.equal(h.controller.getState(), terminal);
  h.controller.setSelection(input(2)); h.controller.dispose(); await h.tick(); assert.equal(h.calls.length, 1);
  assert.equal(terminal.status, 'disposed'); assert.equal(terminal.group, null);
});
test('a reentrant rendering callback cannot send work for an obsolete selection', async () => {
  let controller, changed = false;
  const h = harness({ onChange: state => {
    if (state.status === 'loading' && !changed) { changed = true; controller.setSelection(input(2)); }
  } }); controller = h.controller;
  controller.setSelection(input()); await h.tick(); assert.equal(h.calls.length, 0);
  await h.tick(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.selection.revision, 2);
});
test('a rendering callback failure cannot orphan or duplicate the request', async () => {
  const h = harness({ onChange() { throw new Error('render failed'); } });
  h.controller.setSelection(input()); await h.tick(); await h.complete(0); assert.equal(h.controller.getState().status, 'ready');
  assert.equal(h.calls.length, 1);
});
test('Web Crypto default digest matches the server canonical fingerprint', async () => {
  const h = harness({ fingerprint: undefined }); h.controller.setSelection(input(1, [pocket('b', ['B', 'A']), pocket('a', [])]));
  await h.tick(); for (let i = 0; !h.calls.length && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.calls.length, 1); await h.complete(0); assert.equal(h.controller.getState().status, 'ready');
  assert.equal(h.controller.getState().group.binding.selectionFingerprint, selectionHash(h.calls[0].request));
});

test('actual cached mappings, full-population calculation, summary and parcel producer agree with the controller', async () => {
  // Synthetic source observations, not original-acquisition authority or live
  // SQL/MVCC coverage. This is a real cross-layer representation test.
  const scope = { organization_id: context.context_id, appraisal_case_id: context.context_id,
    subject_snapshot_id: context.context_id, account_id: 'SUBJECT' }, accounts = ['A', 'B'];
  const uint = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const bytes = features(new Set()).map(feature => Buffer.concat([Buffer.from([1]), uint(0x20000003), uint(4326), uint(1), uint(4),
    ...feature.geometry.coordinates[0].map(([x, y]) => { const b = Buffer.alloc(16); b.writeDoubleLE(x); b.writeDoubleLE(y, 8); return b; })]));
  const parcels = accounts.map((account_id, i) => ({ object_id: String(i + 1), account_id, residential_year_built: 1980 + i * 10,
    residential_area_sqft: 1400 + i * 600, parcel_area_sqft: 7000, current_market_value: 300000 + i * 20000,
    source_record_hash: 'c'.repeat(64), stored_geometry_ewkb: bytes[i].toString('hex') }));
  const sales = Array.from({ length: 80 }, (_, i) => ({ source_record_id: String(i + 1), sale_id: String(i + 1),
    primary_account_id: accounts[i % 2], sale_account_id: accounts[i % 2], record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: 250000 + i * 1000,
    source_current_price: 275000 + i * 1000, source_days_on_market: i }));
  const groups = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: parcels.map(row => ({ record_id: `parcel:${row.object_id}`, data: mapCachedParcelRow(row) })),
    accounts: accounts.map(account_id => ({ record_id: `account:${account_id}`, data: mapCachedAccountRow({ account_id }) })),
    transactions: sales.map(row => ({ record_id: `sale:${row.source_record_id}`, data: mapCachedSaleRow(row) })), sale_links: [], gis_sync: [] };
  const capturedAt = '2026-09-09T08:00:00.000Z';
  const source_capture = buildCachedSourceCaptures({ scope, captures: Object.entries(groups).map(([role, records]) => ({
    upstream: { id: `test:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: capturedAt, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `test-${role}`, provider: 'Synthetic mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: capturedAt, historical_availability: 'unknown' },
    projection: { id: `test-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(source_capture.status, 'ready');
  const retained_inputs = { subject: { target: scope, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } },
    spatial: { status: 'captured', query_complete: true, account_ids: accounts,
      parcels: parcels.map((row, i) => ({ object_id: row.object_id, account_id: row.account_id,
        source_record_hash: row.source_record_hash, geometry_sha256: hash(bytes[i]) })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      capture_result: { status: 'captured', query_complete: true, captured_at: capturedAt, source_capture } } };
  const h = harness();
  for (const [revision, pockets, count] of [[1, [pocket('both', ['B', 'A'])], 80], [2, [pocket('a', ['A'])], 40], [3, [], 0]]) {
    h.controller.setSelection(input(revision, pockets)); await h.tick(); const call = h.calls.at(-1);
    const preview = buildCustomCohortObservationPreview({ context_ref: call.request.contextRef, retained_inputs, selection: call.request.selection });
    const summary = presentCustomCohortPreview({ preview, expected: { context_ref: call.request.contextRef, selection_revision: revision } });
    const parcel_map = call.request.include_map ? buildCustomCohortParcelMap({ retained_inputs, selected_account_ids: [...selected(call.request)] })
      : { status: 'omitted', reason: 'geometry_not_requested' };
    const r = response(call.request); r.summary = summary; r.parcel_map = parcel_map;
    // An HTTP JSON boundary detaches any pure-producer shared references.
    await h.complete(h.calls.length - 1, JSON.parse(JSON.stringify(r)));
    const state = h.controller.getState(); assert.equal(state.status, 'ready');
    assert.deepEqual(state.group.summary, summary); assert.equal(state.group.summary.selected.transactions.member_count, count);
    assert.equal(state.group.summary.all.transactions.member_count, 80, 'no thirty-sale cap');
    assert.equal(state.group.parcel_map.counts.selected_accounts, selected(call.request).size);
    assert.equal(state.group.binding.selectionFingerprint, summary.binding.selection_sha256);
  }
});
