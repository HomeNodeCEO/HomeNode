import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortMapManifest } from '../src/services/neighborhoodAssessment/customCohortMapManifest.js';
import { createCustomCohortPreparedMapOpeningRepository, encodeCustomCohortPreparedMapOpening,
  customCohortMapOpeningDigest as hash } from '../src/services/neighborhoodAssessment/customCohortPreparedMapOpeningRepository.js';
import { runCustomCohortPreparedMapOpeningJob } from '../src/services/neighborhoodAssessment/customCohortPreparedMapOpeningJob.js';

const context = { context_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', context_revision: '1', context_sha256: 'a'.repeat(64) };
const scope = { organization_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', report_file_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assignment_file_id: '14', account_id: 'SUBJECT' };
const payload = { catalog: { catalog_version: 3, catalog_complete: true, authority: 'not_established',
  apply: { status: 'blocked' }, binding: { context_ref: context, selection_revision: 1,
    selection_sha256: hash(JSON.stringify({ pockets: [], revision: 1 })) }, subject_membership: { account_id: scope.account_id },
  pockets: [{ id: 'one', label: 'One', county: 'Dallas', account_ids: ['SUBJECT', 'OTHER'] }], unassigned: { account_ids: [] } } };
const feature = (id, account, x) => ({ type: 'Feature', id: `gis.dcad_parcels:${id}`,
  properties: { object_id: String(id), account_id: account, selected: false },
  geometry: { type: 'Polygon', coordinates: [[[x, 32], [x + .01, 32], [x + .01, 32.01], [x, 32.01], [x, 32]]] } });
const map = { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
  geojson: { type: 'FeatureCollection', features: [feature(1, 'SUBJECT', -96.8), feature(2, 'OTHER', -96.9)] },
  counts: { parcels: 2, accounts: 2, selected_accounts: 0 } };
map.counts.geojson_bytes = Buffer.byteLength(JSON.stringify(map.geojson));
const expected = buildCustomCohortMapManifest(payload.catalog, map);
async function storedRow(manifest = expected) {
  const encoded = await encodeCustomCohortPreparedMapOpening(manifest);
  const row = { status: 'available', reason: null, payload_sha256: encoded.digest,
    payload_utf8_bytes: encoded.bytes, compressed_payload: encoded.compressed };
  for (const kind of ['catalog', 'compressed_catalog', 'preview', 'compressed_preview', 'map', 'compressed_map'])
    row[`source_${kind}_sha256`] = row[`current_${kind}_sha256`] = kind === 'catalog' ? hash(JSON.stringify(payload)) : hash(kind);
  return row;
}
function reader(row, changedScope = scope) {
  const calls = [];
  const repo = createCustomCohortPreparedMapOpeningRepository({ async query(sql, values) {
    calls.push({ sql, values }); return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
  } }, json(changedScope), context);
  return { repo, calls };
}

test('compact prepared opening retains the exact original metadata and verifies every original compressed digest', async () => {
  const { repo, calls } = reader(await storedRow());
  assert.deepEqual(await repo.read(payload), expected);
  assert.deepEqual(calls[0].values, [scope.organization_id, context.context_id, context.context_sha256,
    scope.report_file_id, scope.assignment_file_id, scope.account_id]);
  assert.match(calls[0].sql, /o\.report_file_id=\$4::uuid AND o\.assignment_file_id=\$5::bigint AND o\.account_id=\$6/);
  for (const name of ['compressed_payload', 'compressed_preview', 'compressed_map'])
    assert.match(calls[0].sql, new RegExp(`sha256\\([cp]\\.${name}\\)`));
  assert.doesNotMatch(calls[0].sql, /SELECT[^]*?\bp\.compressed_map\s*(?:,|FROM)/);
  assert.equal(Object.hasOwn(expected, 'geojson'), false);
});

test('missing or explicitly unsupported derivative preserves full-map fallback, not invented labels', async () => {
  assert.equal(await reader(null).repo.read(payload), null);
  const row = await storedRow(); row.status = 'unavailable'; row.reason = 'capacity_exceeded';
  row.payload_sha256 = row.payload_utf8_bytes = row.compressed_payload = null;
  assert.equal(await reader(row).repo.read(payload), null);
  row.reason = 'invented';
  await assert.rejects(reader(row).repo.read(payload), /storage_conflict/);
});

test('changed original text or actual compressed bytes refuse even if derivative metadata is unchanged', async () => {
  for (const kind of ['catalog', 'compressed_catalog', 'preview', 'compressed_preview', 'map', 'compressed_map']) {
    const row = await storedRow(); row[`current_${kind}_sha256`] = '0'.repeat(64);
    await assert.rejects(reader(row).repo.read(payload), /storage_conflict/, kind);
  }
  const altered = structuredClone(payload); altered.catalog.pockets[0].label = 'Different';
  await assert.rejects(reader(await storedRow()).repo.read(altered), /storage_conflict/);
});

test('corrupt, oversized or detached compact payload never falls back silently', async () => {
  for (const change of [row => { row.payload_sha256 = '0'.repeat(64); },
    row => { row.payload_utf8_bytes++; }, row => { row.payload_utf8_bytes = 4_000_001; },
    row => { row.compressed_payload = Buffer.from('broken'); }, row => { row.status = 'unknown'; }]) {
    const row = await storedRow(); change(row);
    await assert.rejects(reader(row).repo.read(payload), /storage_conflict/);
  }
  const wrong = structuredClone(expected); wrong.context_ref.context_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await assert.rejects(reader(await storedRow(wrong)).repo.read(payload), /storage_conflict/);
  await assert.rejects(reader(await storedRow(), { ...scope, account_id: 'WRONG' }).repo.read(payload), /storage_conflict/);
});

test('recorded labels, complete counts and retained subject anchors cannot become another membership', async () => {
  for (const change of [x => { x.labels.features[0].properties.account_id = 'UNKNOWN'; },
    x => { x.labels.features[0].properties.label = 'Different'; },
    x => { x.labels.features.push(x.labels.features[0]); },
    x => { x.labels.features = []; }, x => { x.counts.captured_accounts = 1; },
    x => { x.subject_parcels[0].account_id = 'OTHER'; }, x => { x.subject_parcels = []; },
    x => { x.labels.features[0].geometry.coordinates = [-95, 32]; },
    x => { x.bounds[0][0] = 999; }, x => { x.subject_parcels[0].coordinates = [NaN, 32]; }]) {
    const changed = structuredClone(expected); change(changed);
    await assert.rejects(reader(await storedRow(changed)).repo.read(payload), /storage_conflict/);
  }
});

test('genuinely unavailable original geometry remains unavailable without a new legal boundary', async () => {
  const manifest = buildCustomCohortMapManifest(payload.catalog, { ...map, status: 'unavailable', reason: 'geometry_missing', geojson: null });
  assert.deepEqual(await reader(await storedRow(manifest)).repo.read(payload), manifest);
});

const encoded = value => { const text = Buffer.from(JSON.stringify(value));
  return { sha256: hash(text), utf8_bytes: text.length, compressed: gzipSync(text) }; };
function jobSource(contextRef = context) {
  const preview = { preview_version: 2, context_ref: contextRef, target: { ...scope, snapshot_version: 1 }, all: { account_ids: ['OTHER', 'SUBJECT'] } };
  const catalogPayload = structuredClone(payload); catalogPayload.catalog.binding.context_ref = contextRef;
  const p = encoded(preview), m = encoded(map), c = encoded(catalogPayload);
  return { ...scope, context_id: contextRef.context_id, context_sha256: contextRef.context_sha256,
    preview_sha256: p.sha256, preview_utf8_bytes: p.utf8_bytes, compressed_preview: p.compressed,
    map_sha256: m.sha256, map_utf8_bytes: m.utf8_bytes, compressed_map: m.compressed,
    catalog_sha256: c.sha256, compressed_catalog_sha256: hash(c.compressed), catalog: c };
}
function jobPool(rows, { locked = true, insertFailure = false } = {}) {
  const calls = []; let released = false, current;
  return { calls, released: () => released, pool: { async connect() { return { release() { released = true; }, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('map-opening:next')) { current = rows.shift(); return { rowCount: current ? 1 : 0, rows: current ? [current] : [] }; }
    if (sql.includes('prepared-catalog:read')) return { rowCount: 1, rows: [{ payload_sha256: current.catalog.sha256,
      payload_utf8_bytes: current.catalog.utf8_bytes, compressed_payload: current.catalog.compressed }] };
    if (sql.includes('map-opening:insert') && insertFailure) throw new Error('synthetic_insert_failure');
    return { rowCount: 1, rows: [] };
  } }; } } };
}

test('bounded offline pass derives one complete opening in a transaction with all original hashes', async () => {
  const source = jobSource(), fixture = jobPool([source]);
  const result = await runCustomCohortPreparedMapOpeningJob(fixture.pool, { maximumContexts: 1, logger: { info() { throw new Error('logging'); } } });
  assert.deepEqual(result, { status: 'complete', completed: 1, unavailable: 0 });
  const insert = fixture.calls.find(call => call.sql.includes('map-opening:insert'));
  assert.deepEqual(insert.values.slice(0, 9), [scope.organization_id, context.context_id, context.context_sha256,
    source.catalog_sha256, source.compressed_catalog_sha256, source.preview_sha256,
    hash(source.compressed_preview), source.map_sha256, hash(source.compressed_map)]);
  assert.deepEqual(insert.values.slice(9, 11), ['available', null]);
  assert.equal(fixture.calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.ok(fixture.released());
  assert.ok(!fixture.calls.some(call => /UPDATE|DELETE|TRUNCATE|neighborhood-cache:/.test(call.sql)));
});

test('invalid source records no partial display, continues later contexts and never repairs original facts', async () => {
  const bad = jobSource(), good = jobSource({ ...context, context_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  bad.compressed_map = Buffer.from('broken');
  const fixture = jobPool([bad, good]);
  assert.deepEqual(await runCustomCohortPreparedMapOpeningJob(fixture.pool, { maximumContexts: 2, logger: {} }),
    { status: 'complete', completed: 1, unavailable: 1 });
  const inserts = fixture.calls.filter(call => call.sql.includes('map-opening:insert'));
  assert.deepEqual(inserts[0].values.slice(9), ['unavailable', 'source_invalid', null, null, null]);
  assert.equal(fixture.calls.filter(call => call.sql === 'COMMIT').length, 2);
});

test('job overlap, input limits and failed publication release resources with no partial commit', async () => {
  const overlap = jobPool([], { locked: false });
  assert.equal((await runCustomCohortPreparedMapOpeningJob(overlap.pool)).status, 'already_running');
  assert.ok(overlap.released()); assert.ok(!overlap.calls.some(call => call.sql === 'BEGIN'));
  const failed = jobPool([jobSource()], { insertFailure: true });
  await assert.rejects(runCustomCohortPreparedMapOpeningJob(failed.pool, { logger: {} }), /synthetic_insert_failure/);
  assert.ok(failed.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!failed.calls.some(call => call.sql === 'COMMIT')); assert.ok(failed.released());
  await assert.rejects(runCustomCohortPreparedMapOpeningJob({}, { maximumContexts: 0 }), /invalid_job/);
});

test('new immutable derivative migration is ordered after unchanged originals and retains bounded FKs', () => {
  const sql = fs.readFileSync(new URL('../migrations/20261101_custom_cohort_prepared_map_openings.sql', import.meta.url), 'utf8');
  const registry = fs.readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.ok(registry.indexOf('20261101_custom_cohort_prepared_map_openings.sql') > registry.indexOf('20261031_custom_cohort_group_selections.sql'));
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /REFERENCES app\.neighborhood_custom_cohort_prepared_previews/);
  assert.match(sql, /REFERENCES app\.neighborhood_custom_cohort_prepared_catalogs/);
  assert.match(sql, /BETWEEN 1 AND 4000000/);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP TABLE|DELETE FROM|TRUNCATE app|INSERT INTO|UPDATE app/);
});
