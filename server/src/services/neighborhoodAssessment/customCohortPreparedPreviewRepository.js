import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { createCustomPreparedPreviewReadTiming } from './customCapturePhaseTiming.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { isCustomCohortObservationPreview,
  reselectCustomCohortIndexedObservationPreview,
  restoreCustomCohortIndexedObservationPreview } from './customCohortObservationPreview.js';
import { registerCustomCohortPreparedViewportMap,
  visibleCustomCohortPreparedFeatures } from './customCohortViewportMap.js';
import { requestedCustomCohortPreparedTileKeys,
  restoreCustomCohortPreparedTileFeatures } from './customCohortPreparedViewportTiles.js';

const LIMITS = Object.freeze({ preview: { text: 64_000_000, compressed: 12_000_000 },
  map: { text: 32_000_000, compressed: 16_000_000 } });
// The prepared row is immutable for a context/format version. Keep only one
// bounded, verified, deeply frozen read model hot across requests. The
// current row and its compressed bytes are still checked on every hit, but
// PostgreSQL returns digests instead of retransmitting the blobs on hot hits;
// selection-dependent results are never cached here.
const HOT_PREVIEW_MAX_BYTES = 60_000_000;
const HOT_MAP_MAX_BYTES = 24_000_000;
const HOT_PREVIEW_MAX_PROCESS_RSS_BYTES = 1_000_000_000;
const HOT_PREVIEW_TTL_MS = 5 * 60_000;
let hotPreview = null;
let hotPreviewTimer = null;
// The stored JSON length and digest certify the neutral map's recorded GeoJSON
// byte count. Only maps derived from that certified object may use byte deltas;
// synthetic/legacy inputs retain the full serialization guard.
const verifiedMapBytes = new WeakSet();
const representedMapAccounts = new WeakMap();
function clearHotPreview() {
  if (hotPreviewTimer) clearTimeout(hotPreviewTimer);
  hotPreview = null;
  hotPreviewTimer = null;
}
function retainHotPreview(entry) {
  clearHotPreview();
  hotPreview = entry;
  hotPreviewTimer = setTimeout(() => {
    if (hotPreview === entry) clearHotPreview();
  }, HOT_PREVIEW_TTL_MS);
  hotPreviewTimer.unref?.();
}
function freezeMap(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeMap(child);
    Object.freeze(value);
  }
  return value;
}
const compress = promisify(gzip), decompress = promisify(gunzip);
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(reason) { throw new TypeError(`custom_cohort_prepared_preview_${reason}`); }
function check(value, reason) { if (!value) fail(reason); }
function one(result) {
  check(result?.rowCount === 1 && Array.isArray(result.rows) && result.rows.length === 1,
    'storage_conflict');
  return result.rows[0];
}

/** Derived read model only. A caller must first perform current assignment,
 * original-context and market/private-policy checks in its own transaction;
 * this repository does not authenticate or authorize anyone. There is no
 * update path: a changed algorithm uses a new format version, not mutation.
 */
export function createCustomCohortPreparedPreviewRepository(client, scopeJson, contextRef) {
  check(typeof client?.query === 'function', 'client_required');
  const scope = prepareCustomCohortContextScope(scopeJson);
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(contextRef));
  const key = [scope.organization_id, context.context_id, context.context_sha256];
  const hotKey = JSON.stringify([...key, scope.report_file_id, scope.assignment_file_id, scope.account_id]);
  const matchesScope = preview => preview.target?.organization_id === scope.organization_id
    && preview.target?.report_file_id === scope.report_file_id
    && preview.target?.assignment_file_id === scope.assignment_file_id
    && preview.target?.account_id === scope.account_id;
  const query = client.query.bind(client);
  const encode = async (value, kind) => {
    const text = Buffer.from(JSON.stringify(value), 'utf8');
    check(text.length > 0 && text.length <= LIMITS[kind].text, 'capacity_exceeded');
    const compressed = await compress(text, { level: 1 });
    check(compressed.length > 0 && compressed.length <= LIMITS[kind].compressed, 'capacity_exceeded');
    return { digest: hash(text), bytes: text.length, compressed };
  };
  const decode = async (row, kind) => {
    const digest = row[`${kind}_sha256`], bytes = row[`${kind}_utf8_bytes`],
      compressed = row[`compressed_${kind}`];
    check(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
      && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= LIMITS[kind].text
      && Buffer.isBuffer(compressed) && compressed.length > 0
      && compressed.length <= LIMITS[kind].compressed, 'storage_conflict');
    let text;
    try { text = await decompress(compressed, { maxOutputLength: LIMITS[kind].text }); }
    catch { fail('storage_conflict'); }
    check(text.length === bytes && hash(text) === digest, 'storage_conflict');
    try { return JSON.parse(text.toString('utf8')); } catch { fail('storage_conflict'); }
  };
  const exists = async () => {
    const found = await query(`/* custom-cohort-prepared-preview:exists */
      SELECT 1 FROM app.neighborhood_custom_cohort_prepared_previews
      WHERE organization_id=$1::uuid AND context_id=$2::uuid
        AND context_sha256=$3 AND format_version=1`, key);
    check(found && [0, 1].includes(found.rowCount) && Array.isArray(found.rows)
      && found.rows.length === found.rowCount, 'storage_conflict');
    return found.rowCount === 1;
  };
  const read = async ({ includeMap = true, useVerifiedPreviewCache = false } = {}) => {
    check(typeof includeMap === 'boolean' && typeof useVerifiedPreviewCache === 'boolean', 'invalid_read');
    const timed = createCustomPreparedPreviewReadTiming();
    let previous = useVerifiedPreviewCache && hotPreview?.key === hotKey
      && hotPreview.expiresAt > Date.now() ? hotPreview : null;
    if (previous && (!includeMap || previous.map)) {
      // The stored text digest alone would miss damaged compressed bytes with
      // unchanged metadata. Hash those bytes in PostgreSQL, without sending up
      // to 28 MB back to Node just to verify an already-decoded immutable value.
      // This saves network/copy work, not database hashing or authorization.
      const verified = await timed('cache_verify', () => query(`/* custom-cohort-prepared-preview:verify-hot */
        SELECT preview_sha256, preview_utf8_bytes,
          pg_catalog.encode(pg_catalog.sha256(compressed_preview), 'hex') AS compressed_preview_sha256
          ${includeMap ? `, map_sha256, map_utf8_bytes,
            pg_catalog.encode(pg_catalog.sha256(compressed_map), 'hex') AS compressed_map_sha256` : ''}
        FROM app.neighborhood_custom_cohort_prepared_previews
        WHERE organization_id=$1::uuid AND context_id=$2::uuid
          AND context_sha256=$3 AND format_version=1`, key));
      if (verified?.rowCount === 0) { clearHotPreview(); return null; }
      const metadata = one(verified);
      if (metadata.preview_sha256 === previous.digest && metadata.preview_utf8_bytes === previous.bytes
        && metadata.compressed_preview_sha256 === previous.compressedDigest
        && (!includeMap || (metadata.map_sha256 === previous.mapDigest
          && metadata.map_utf8_bytes === previous.mapBytes
          && metadata.compressed_map_sha256 === previous.compressedMapDigest))) {
        return Object.freeze({ preview: previous.preview, parcel_map: includeMap ? previous.map : null });
      }
      clearHotPreview();
      previous = null;
    }
    const found = await timed('query', () => query(`/* custom-cohort-prepared-preview:read */
      SELECT preview_sha256, preview_utf8_bytes, compressed_preview
        ${includeMap ? ', map_sha256, map_utf8_bytes, compressed_map' : ''}
      FROM app.neighborhood_custom_cohort_prepared_previews
      WHERE organization_id=$1::uuid AND context_id=$2::uuid
        AND context_sha256=$3 AND format_version=1`, key));
    if (found?.rowCount === 0) return null;
    const row = one(found);
    const compressedDigest = useVerifiedPreviewCache && Buffer.isBuffer(row.compressed_preview)
      ? hash(row.compressed_preview) : null;
    const compressedMapDigest = useVerifiedPreviewCache && includeMap && Buffer.isBuffer(row.compressed_map)
      ? hash(row.compressed_map) : null;
    const matched = previous && row.preview_sha256 === previous.digest
      && row.preview_utf8_bytes === previous.bytes
      && Buffer.isBuffer(row.compressed_preview)
      && compressedDigest === previous.compressedDigest;
    if (previous && !matched) clearHotPreview();
    let preview = matched ? previous.preview : null;
    if (!preview) {
      const parsed = await timed('preview_decode', () => decode(row, 'preview'));
      check(parsed && canonicalAssessmentJson(parsed.context_ref) === canonicalAssessmentJson(context)
        && matchesScope(parsed), 'storage_conflict');
      preview = await timed('preview_restore', () => {
        const tableBytes = row.preview_utf8_bytes
          - Buffer.byteLength(JSON.stringify({ ...parsed, member_tables: null })) + 4;
        return restoreCustomCohortIndexedObservationPreview(parsed, tableBytes);
      });
    }
    const retainVerifiedReadModel = (map = null, mapMatched = false) => {
      if (!useVerifiedPreviewCache || (matched && (!map || mapMatched))
        || row.preview_utf8_bytes > HOT_PREVIEW_MAX_BYTES
        || process.memoryUsage().rss > HOT_PREVIEW_MAX_PROCESS_RSS_BYTES) return;
      const entry = { key: hotKey, digest: row.preview_sha256, bytes: row.preview_utf8_bytes,
        compressedDigest, preview,
        expiresAt: Date.now() + HOT_PREVIEW_TTL_MS };
      if (map && row.map_utf8_bytes <= HOT_MAP_MAX_BYTES) {
        entry.map = freezeMap(map);
        entry.mapDigest = row.map_sha256;
        entry.mapBytes = row.map_utf8_bytes;
        entry.compressedMapDigest = compressedMapDigest;
      }
      retainHotPreview(entry);
    };
    if (!includeMap) {
      retainVerifiedReadModel();
      return Object.freeze({ preview, parcel_map: null });
    }
    const mapMatched = matched && previous.map && row.map_sha256 === previous.mapDigest
      && row.map_utf8_bytes === previous.mapBytes
      && Buffer.isBuffer(row.compressed_map)
      && compressedMapDigest === previous.compressedMapDigest;
    if (matched && previous.map && !mapMatched) clearHotPreview();
    const map = mapMatched ? previous.map : await timed('map_decode', () => decode(row, 'map'));
    check(map && ['available', 'unavailable'].includes(map.status)
      && (map.status === 'available' ? map.geojson?.type === 'FeatureCollection'
        && Array.isArray(map.geojson.features) : map.geojson === null), 'storage_conflict');
    if (map.status === 'available' && Number.isSafeInteger(map.counts?.geojson_bytes)
      && map.counts.geojson_bytes > 0 && map.counts.geojson_bytes <= LIMITS.map.text) {
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ ...map, geojson: null }));
      if (envelopeBytes - 4 + map.counts.geojson_bytes === row.map_utf8_bytes) {
        freezeMap(map);
        verifiedMapBytes.add(map);
      }
    }
    retainVerifiedReadModel(map, mapMatched);
    return Object.freeze({ preview, parcel_map: map });
  };
  return Object.freeze({
    exists,
    read,
    async readViewportTiles(viewport, preview) {
      check(isCustomCohortObservationPreview(preview) && Array.isArray(preview.all?.account_ids),
        'prepared_index_required');
      const found = await query(`/* custom-cohort-prepared-tiles:read-manifest */
        SELECT m.*, p.preview_sha256 AS current_preview_sha256,
          p.map_sha256 AS current_map_sha256,
          pg_catalog.encode(pg_catalog.sha256(p.compressed_map), 'hex') AS current_compressed_map_sha256
        FROM app.neighborhood_custom_cohort_prepared_tile_manifests m
        JOIN app.neighborhood_custom_cohort_prepared_previews p
          ON p.organization_id=m.organization_id AND p.context_id=m.context_id
          AND p.format_version=m.format_version
        WHERE m.organization_id=$1::uuid AND m.context_id=$2::uuid
          AND m.context_sha256=$3 AND m.format_version=1`, key);
      if (found?.rowCount === 0) return null;
      const manifest = one(found);
      check(manifest.source_preview_sha256 === manifest.current_preview_sha256
        && manifest.source_map_sha256 === manifest.current_map_sha256
        && manifest.source_compressed_map_sha256 === manifest.current_compressed_map_sha256,
      'storage_conflict');
      if (manifest.status === 'unavailable') return null;
      check(manifest.status === 'available' && Number.isSafeInteger(manifest.captured_parcels)
        && manifest.captured_parcels > 0 && manifest.captured_parcels <= 100_000
        && manifest.account_set_sha256 === hash(Buffer.from(JSON.stringify([...preview.all.account_ids].sort())))
        && typeof manifest.map_shell_json === 'string'
        && manifest.map_shell_sha256 === hash(Buffer.from(manifest.map_shell_json)), 'storage_conflict');
      let shell;
      try { shell = JSON.parse(manifest.map_shell_json); } catch { fail('storage_conflict'); }
      check(shell?.status === 'available' && shell.geojson === null
        && shell.counts?.parcels === manifest.captured_parcels, 'storage_conflict');
      const keys = requestedCustomCohortPreparedTileKeys(manifest.cell_keys_json, viewport);
      check(keys.length > 0, 'storage_conflict');
      const placeholders = keys.map((_pair, index) => `($${3 + index * 2},$${4 + index * 2})`).join(',');
      const rows = await query(`/* custom-cohort-prepared-tiles:read-cells */
        SELECT cell_x, cell_y, tile_sha256, tile_utf8_bytes, compressed_tile
        FROM app.neighborhood_custom_cohort_prepared_tiles
        WHERE organization_id=$1::uuid AND context_id=$2::uuid AND format_version=1
          AND (cell_x,cell_y) IN (${placeholders})`, [scope.organization_id, context.context_id,
        ...keys.flat()]);
      check(rows && Array.isArray(rows.rows) && rows.rowCount === rows.rows.length, 'storage_conflict');
      const features = await restoreCustomCohortPreparedTileFeatures(rows.rows, keys, manifest.captured_parcels);
      const allAccounts = new Set(preview.all.account_ids);
      check(features.every(feature => allAccounts.has(feature.properties.account_id)), 'storage_conflict');
      return freezeMap({ ...shell, geojson: { type: 'FeatureCollection', features } });
    },
    async put(preview, parcelMap) {
      check(isCustomCohortObservationPreview(preview) && preview.preview_version === 2
        && canonicalAssessmentJson(preview.context_ref) === canonicalAssessmentJson(context)
        && matchesScope(preview),
      'prepared_index_required');
      check(parcelMap && ['available', 'unavailable'].includes(parcelMap.status),
        'map_required');
      // One context can be opened with different selected pockets. Store the
      // selection-neutral observation index and geometry so every such opening
      // resolves to the same immutable derived row.
      const neutralPreview = reselectCustomCohortIndexedObservationPreview(preview,
        { revision: 1, pockets: [] });
      const neutralMap = selectCustomCohortPreparedParcelMap(parcelMap, []);
      const [storedPreview, storedMap] = await Promise.all([encode(neutralPreview, 'preview'), encode(neutralMap, 'map')]);
      const stored = await query(`/* custom-cohort-prepared-preview:insert */
        INSERT INTO app.neighborhood_custom_cohort_prepared_previews
          (organization_id, context_id, context_sha256, format_version,
           preview_sha256, preview_utf8_bytes, compressed_preview,
           map_sha256, map_utf8_bytes, compressed_map)
        VALUES ($1::uuid,$2::uuid,$3,1,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (organization_id, context_id, format_version) DO NOTHING
        RETURNING preview_sha256, map_sha256`, [...key,
        storedPreview.digest, storedPreview.bytes, storedPreview.compressed,
        storedMap.digest, storedMap.bytes, storedMap.compressed]);
      check(stored?.rowCount === 0 || (stored?.rowCount === 1
        && one(stored).preview_sha256 === storedPreview.digest
        && one(stored).map_sha256 === storedMap.digest), 'insert_result_conflict');
      if (stored.rowCount === 0) {
        const existing = await read();
        check(existing && hash(Buffer.from(JSON.stringify(existing.preview))) === storedPreview.digest
          && hash(Buffer.from(JSON.stringify(existing.parcel_map))) === storedMap.digest,
          'existing_conflict');
      }
      return Object.freeze({ status: stored.rowCount === 1 ? 'prepared' : 'reused',
        preview_sha256: storedPreview.digest, map_sha256: storedMap.digest });
    },
  });
}

/** Selection flags are the only mutable display field. The complete geometry
 * is already retained in this context-bound read model; no topology or parcel
 * membership is inferred on click. */
export function selectCustomCohortPreparedParcelMap(map, accountIds) {
  if (map.status === 'unavailable') return map;
  check(map.status === 'available' && Array.isArray(map.geojson?.features), 'map_required');
  const selected = new Set(accountIds);
  const represented = new Set();
  let exactDelta = 0, useVerifiedBytes = verifiedMapBytes.has(map);
  const features = map.geojson.features.map(feature => {
    const before = feature.properties.selected, after = selected.has(feature.properties.account_id);
    if (typeof before !== 'boolean') useVerifiedBytes = false;
    else exactDelta += Number(before) - Number(after); // JSON true is one byte shorter than false.
    return { ...feature, properties: { ...feature.properties, selected: after } };
  });
  for (const feature of features) represented.add(feature.properties.account_id);
  check([...selected].every(account => represented.has(account)), 'map_membership_mismatch');
  const geojson = { ...map.geojson, features };
  const geojsonBytes = useVerifiedBytes ? map.counts.geojson_bytes + exactDelta
    : Buffer.byteLength(JSON.stringify(geojson));
  check(geojsonBytes <= 32_000_000, 'map_capacity_exceeded');
  const output = { ...map, geojson,
    counts: { ...map.counts, selected_accounts: selected.size, geojson_bytes: geojsonBytes } };
  if (useVerifiedBytes) {
    freezeMap(output);
    verifiedMapBytes.add(output);
    registerCustomCohortPreparedViewportMap(output, map);
  }
  return output;
}

/** A viewport needs only a fraction of a verified map. Check selection against
 * the full captured roster, then clone flags on visible features only. Unknown
 * or uncertified maps keep the existing full-map path and all its guards. */
export function selectCustomCohortPreparedParcelViewportMap(map, accountIds, viewport) {
  if (map.status === 'unavailable' || !verifiedMapBytes.has(map))
    return selectCustomCohortPreparedParcelMap(map, accountIds);
  check(map.status === 'available' && Array.isArray(map.geojson?.features)
    && Object.isFrozen(map.geojson.features), 'map_required');
  const selected = new Set(accountIds);
  let represented = representedMapAccounts.get(map);
  if (!represented) {
    represented = new Set(map.geojson.features.map(feature => feature.properties.account_id));
    representedMapAccounts.set(map, represented);
  }
  check([...selected].every(account => represented.has(account)), 'map_membership_mismatch');
  const features = visibleCustomCohortPreparedFeatures(map, viewport, accountIds);
  const geojson = { type: 'FeatureCollection', features };
  return freezeMap({ ...map, geojson, counts: { ...map.counts,
    selected_accounts: selected.size, geojson_bytes: Buffer.byteLength(JSON.stringify(geojson)) } });
}

/** A complete, offline-published source-map identity has already established
 * that every numeric member is represented. Only visible display flags change. */
export function selectCustomCohortPreparedTileViewportMap(map, accountIds, allAccountIds) {
  check(map?.status === 'available' && Array.isArray(map.geojson?.features)
    && Array.isArray(allAccountIds), 'map_required');
  const selected = new Set(accountIds), all = new Set(allAccountIds);
  check([...selected].every(account => all.has(account)), 'map_membership_mismatch');
  const geojson = { type: 'FeatureCollection', features: map.geojson.features.map(feature => ({
    ...feature, properties: { ...feature.properties,
      selected: selected.has(feature.properties.account_id) },
  })) };
  return freezeMap({ ...map, geojson, counts: { ...map.counts,
    selected_accounts: selected.size, geojson_bytes: Buffer.byteLength(JSON.stringify(geojson)) } });
}

/** Exact JSON length without revisiting every certified parcel coordinate.
 * Uncertified or unavailable maps still use the original full-size guard. */
export function customCohortPreparedParcelMapJsonBytes(map) {
  if (map?.status !== 'available' || !verifiedMapBytes.has(map)) return Buffer.byteLength(JSON.stringify(map));
  return Buffer.byteLength(JSON.stringify({ ...map, geojson: null })) - 4 + map.counts.geojson_bytes;
}
