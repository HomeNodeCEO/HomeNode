import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildCustomCohortPreparedViewportTiles, requestedCustomCohortPreparedTileKeys,
  restoreCustomCohortPreparedTileFeatures } from '../src/services/neighborhoodAssessment/customCohortPreparedViewportTiles.js';
import { runCustomCohortPreparedViewportTileJob }
  from '../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';

const square = (id, account, west, south, east, north) => ({
  type: 'Feature', id, properties: { account_id: account, selected: false },
  geometry: { type: 'Polygon', coordinates: [[
    [west, south], [east, south], [east, north], [west, north], [west, south],
  ]] },
});
const featureA = square('a', 'A', -96.701, 32.801, -96.699, 32.803);
const featureB = square('b', 'B', -96.689, 32.811, -96.687, 32.813);
const source = { status: 'available', geometry_semantics: 'retained',
  geojson: { type: 'FeatureCollection', features: [featureA, featureB] },
  counts: { parcels: 2, accounts: 2, selected_accounts: 0, geojson_bytes: 1 } };

test('offline tiles preserve complete original polygons and exact tile-edge duplicates', async () => {
  const built = await buildCustomCohortPreparedViewportTiles({ all: { account_ids: ['B', 'A'] } }, source);
  const viewport = { west: -96.702, south: 32.8, east: -96.698, north: 32.804 };
  const keys = requestedCustomCohortPreparedTileKeys(built.cell_keys_json, viewport);
  const wanted = new Set(keys.map(pair => pair.join(':')));
  const rows = built.tiles.filter(tile => wanted.has(`${tile.cell_x}:${tile.cell_y}`)).map(tile => ({
    ...tile, tile_sha256: tile.sha256, tile_utf8_bytes: tile.utf8_bytes, compressed_tile: tile.compressed,
  }));
  assert.ok(rows.length >= 2, 'edge-crossing parcel appears in multiple source cells');
  const visible = await restoreCustomCohortPreparedTileFeatures(rows, keys, 2);
  assert.deepEqual(visible, [featureA], 'deduplication preserves source ordering and every ring coordinate');
  assert.equal(built.captured_parcels, 2);
  assert.equal(built.map_shell_sha256.length, 64);
  await assert.rejects(restoreCustomCohortPreparedTileFeatures(rows.slice(1), keys, 2), /storage_conflict/);
  const damaged = rows.map((row, index) => index ? row : { ...row, tile_sha256: '0'.repeat(64) });
  await assert.rejects(restoreCustomCohortPreparedTileFeatures(damaged, keys, 2), /storage_conflict/);
});

test('offline publication refuses a map whose parcel identities do not match the numeric population', async () => {
  await assert.rejects(buildCustomCohortPreparedViewportTiles({ all: { account_ids: ['A'] } }, source),
    /membership_mismatch/);
  await assert.rejects(buildCustomCohortPreparedViewportTiles({ all: { account_ids: ['A', 'B'] } },
    { ...source, geojson: { ...source.geojson, features: [
      { ...featureA, properties: { ...featureA.properties, selected: true } }, featureB,
    ] } }), /invalid_feature/);
});

test('worker publishes complete tiles and records a corrupt source without blocking later contexts', async () => {
  const encoded = value => {
    const text = Buffer.from(JSON.stringify(value));
    return { sha256: createHash('sha256').update(text).digest('hex'),
      utf8_bytes: text.length, compressed: gzipSync(text) };
  };
  const context_id = '00000000-0000-0000-0000-000000000001', context_sha256 = 'e'.repeat(64);
  const preview = { preview_version: 2, context_ref: { context_id, context_sha256 },
    all: { account_ids: ['A', 'B'] } };
  const map = { ...source, counts: { ...source.counts,
    geojson_bytes: Buffer.byteLength(JSON.stringify(source.geojson)) } };
  const p = encoded(preview), m = encoded(map);
  const row = { organization_id: '00000000-0000-0000-0000-000000000002', context_id, context_sha256,
    preview_sha256: p.sha256, preview_utf8_bytes: p.utf8_bytes, compressed_preview: p.compressed,
    map_sha256: m.sha256, map_utf8_bytes: m.utf8_bytes, compressed_map: m.compressed };
  const calls = [];
  let nextRows = [row];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('prepared-tiles:next')) {
      if (!nextRows.length) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [nextRows.shift()] };
    }
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const pool = { async connect() { return client; } };
  const result = await runCustomCohortPreparedViewportTileJob(pool, { maximumContexts: 1, logger: {} });
  assert.equal(result.completed, 1);
  assert.ok(result.tiles >= 2);
  assert.ok(calls.some(call => call.sql.includes('prepared-tiles:manifest')));
  assert.equal(calls.filter(call => call.sql.includes('prepared-tiles:tile')).length, result.tiles);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
  calls.length = 0;
  row.compressed_map = Buffer.from(m.compressed); row.compressed_map[0] ^= 1;
  const laterId = '00000000-0000-0000-0000-000000000003';
  const laterPreview = encoded({ ...preview, context_ref: { context_id: laterId, context_sha256 } });
  const laterRow = { ...row, context_id: laterId, preview_sha256: laterPreview.sha256,
    preview_utf8_bytes: laterPreview.utf8_bytes, compressed_preview: laterPreview.compressed,
    compressed_map: m.compressed };
  nextRows = [row, laterRow];
  const continued = await runCustomCohortPreparedViewportTileJob(pool, { maximumContexts: 2, logger: {} });
  assert.equal(continued.unavailable, 1);
  assert.equal(continued.completed, 1);
  const manifests = calls.filter(call => call.sql.includes('prepared-tiles:manifest'));
  assert.deepEqual(manifests.map(call => call.values[7]), ['source_invalid', null]);
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.ok(!calls.some(call => call.sql === 'ROLLBACK'));
});
