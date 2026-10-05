import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { prepareCustomCohortViewport, customCohortGeometryBounds } from './customCohortViewportMap.js';

// A tile is a display-only copy of complete, unchanged parcel features from
// one immutable prepared preview. It never defines analytical membership.
export const CUSTOM_COHORT_PREPARED_TILE_VERSION = 1;
export const CUSTOM_COHORT_PREPARED_TILE_LIMITS = Object.freeze({
  cells: 500, references: 300_000, featureCells: 64,
  tileTextBytes: 4_000_000, tileCompressedBytes: 2_000_000,
  capturedParcels: 100_000,
});
const GRID = 0.01;
const BROAD_CELL = Object.freeze([2147483647, 2147483647]);
const compress = promisify(gzip), decompress = promisify(gunzip);
const digest = value => createHash('sha256').update(value).digest('hex');
const cell = value => Math.floor(value / GRID);
const key = (x, y) => `${x}:${y}`;
function fail(reason) { throw new TypeError(`custom_cohort_prepared_tiles_${reason}`); }
function check(condition, reason) { if (!condition) fail(reason); }
function asCells(geometry) {
  const box = customCohortGeometryBounds(geometry);
  check([box.west, box.south, box.east, box.north].every(Number.isFinite), 'invalid_geometry');
  const left = cell(box.west), right = cell(box.east), bottom = cell(box.south), top = cell(box.north);
  const count = (right - left + 1) * (top - bottom + 1);
  check(Number.isSafeInteger(count) && count > 0, 'invalid_geometry');
  if (count > CUSTOM_COHORT_PREPARED_TILE_LIMITS.featureCells) return [BROAD_CELL];
  const result = [];
  for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) result.push([x, y]);
  return result;
}

/** Build a complete immutable sidecar from already-verified neutral source.
 * Capacity refusal leaves the original full-map read path available. */
export async function buildCustomCohortPreparedViewportTiles(preview, map) {
  check(map?.status === 'available' && map.geojson?.type === 'FeatureCollection'
    && Array.isArray(map.geojson.features) && Array.isArray(preview?.all?.account_ids), 'source_required');
  const features = map.geojson.features;
  check(features.length > 0 && features.length <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.capturedParcels
    && features.length === map.counts?.parcels, 'source_count');
  const represented = [...new Set(features.map(feature => feature?.properties?.account_id))].sort();
  const expected = [...new Set(preview.all.account_ids)].sort();
  check(expected.length === preview.all.account_ids.length && represented.length === expected.length
    && represented.every((account, index) => account === expected[index]), 'membership_mismatch');
  const cells = new Map([[key(...BROAD_CELL), { x: BROAD_CELL[0], y: BROAD_CELL[1], entries: [] }]]);
  let references = 0;
  for (let ordinal = 0; ordinal < features.length; ordinal++) {
    const feature = features[ordinal];
    check(feature?.type === 'Feature' && feature.properties?.selected === false
      && typeof feature.id === 'string' && feature.geometry, 'invalid_feature');
    for (const [x, y] of asCells(feature.geometry)) {
      if (++references > CUSTOM_COHORT_PREPARED_TILE_LIMITS.references) fail('capacity_exceeded');
      const id = key(x, y);
      if (!cells.has(id)) cells.set(id, { x, y, entries: [] });
      cells.get(id).entries.push([ordinal, feature]);
    }
    if (cells.size > CUSTOM_COHORT_PREPARED_TILE_LIMITS.cells) fail('capacity_exceeded');
  }
  const tiles = [];
  for (const item of cells.values()) {
    const text = Buffer.from(JSON.stringify(item.entries), 'utf8');
    check(text.length > 0 && text.length <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.tileTextBytes, 'capacity_exceeded');
    const compressed = await compress(text, { level: 1 });
    check(compressed.length > 0 && compressed.length <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.tileCompressedBytes,
      'capacity_exceeded');
    tiles.push(Object.freeze({ cell_x: item.x, cell_y: item.y, sha256: digest(text),
      utf8_bytes: text.length, compressed }));
  }
  tiles.sort((a, b) => a.cell_x - b.cell_x || a.cell_y - b.cell_y);
  const shell = JSON.stringify({ ...map, geojson: null });
  check(Buffer.byteLength(shell) < 100_000, 'capacity_exceeded');
  const keys = tiles.map(item => [item.cell_x, item.cell_y]);
  return Object.freeze({ tiles, cell_keys_json: JSON.stringify(keys),
    account_set_sha256: digest(JSON.stringify(represented)),
    map_shell_json: shell, map_shell_sha256: digest(shell), captured_parcels: features.length });
}

export function requestedCustomCohortPreparedTileKeys(cellKeysJson, requestedViewport) {
  const viewport = prepareCustomCohortViewport(requestedViewport);
  let keys;
  try { keys = JSON.parse(cellKeysJson); } catch { fail('storage_conflict'); }
  check(Array.isArray(keys) && keys.length > 0 && keys.length <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.cells,
    'storage_conflict');
  const left = cell(viewport.west), right = cell(viewport.east);
  const bottom = cell(viewport.south), top = cell(viewport.north);
  let previous = null;
  return keys.filter(pair => {
    check(Array.isArray(pair) && pair.length === 2 && pair.every(Number.isSafeInteger), 'storage_conflict');
    const id = key(pair[0], pair[1]);
    check(previous === null || previous[0] < pair[0]
      || (previous[0] === pair[0] && previous[1] < pair[1]), 'storage_conflict');
    previous = pair;
    return id === key(...BROAD_CELL)
      || (pair[0] >= left && pair[0] <= right && pair[1] >= bottom && pair[1] <= top);
  });
}

/** Verify every requested tile before returning any candidates. Duplicate
 * features at cell edges must be byte-identical and appear in source order. */
export async function restoreCustomCohortPreparedTileFeatures(rows, expectedKeys, capturedParcels) {
  check(Array.isArray(rows) && rows.length === expectedKeys.length, 'storage_conflict');
  const expected = new Set(expectedKeys.map(pair => key(...pair)));
  const features = new Map();
  for (const row of rows) {
    const id = key(row.cell_x, row.cell_y);
    check(expected.delete(id) && /^[a-f0-9]{64}$/.test(row.tile_sha256)
      && Number.isSafeInteger(row.tile_utf8_bytes)
      && row.tile_utf8_bytes > 0 && row.tile_utf8_bytes <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.tileTextBytes
      && Buffer.isBuffer(row.compressed_tile)
      && row.compressed_tile.length <= CUSTOM_COHORT_PREPARED_TILE_LIMITS.tileCompressedBytes,
    'storage_conflict');
    let text, entries;
    try {
      text = await decompress(row.compressed_tile,
        { maxOutputLength: CUSTOM_COHORT_PREPARED_TILE_LIMITS.tileTextBytes });
      entries = JSON.parse(text.toString('utf8'));
    } catch { fail('storage_conflict'); }
    check(text.length === row.tile_utf8_bytes && digest(text) === row.tile_sha256
      && Array.isArray(entries), 'storage_conflict');
    for (const entry of entries) {
      check(Array.isArray(entry) && entry.length === 2
        && Number.isSafeInteger(entry[0]) && entry[0] >= 0 && entry[0] < capturedParcels
        && entry[1]?.type === 'Feature' && entry[1].properties?.selected === false,
      'storage_conflict');
      const encoded = JSON.stringify(entry[1]);
      if (features.has(entry[0])) check(features.get(entry[0]).encoded === encoded, 'storage_conflict');
      else features.set(entry[0], { feature: entry[1], encoded });
    }
  }
  check(expected.size === 0, 'storage_conflict');
  return [...features.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item.feature);
}
