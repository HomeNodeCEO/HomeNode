import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { isCustomCohortObservationPreview,
  restoreCustomCohortIndexedObservationPreview } from './customCohortObservationPreview.js';

const LIMITS = Object.freeze({ preview: { text: 64_000_000, compressed: 12_000_000 },
  map: { text: 32_000_000, compressed: 16_000_000 } });
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
  const read = async ({ includeMap = true } = {}) => {
    check(typeof includeMap === 'boolean', 'invalid_read');
    const found = await query(`/* custom-cohort-prepared-preview:read */
      SELECT preview_sha256, preview_utf8_bytes, compressed_preview
        ${includeMap ? ', map_sha256, map_utf8_bytes, compressed_map' : ''}
      FROM app.neighborhood_custom_cohort_prepared_previews
      WHERE organization_id=$1::uuid AND context_id=$2::uuid
        AND context_sha256=$3 AND format_version=1`, key);
    if (found?.rowCount === 0) return null;
    const row = one(found);
    const parsed = await decode(row, 'preview');
    check(parsed && canonicalAssessmentJson(parsed.context_ref) === canonicalAssessmentJson(context)
      && matchesScope(parsed),
    'storage_conflict');
    const preview = restoreCustomCohortIndexedObservationPreview(parsed);
    if (!includeMap) return Object.freeze({ preview, parcel_map: null });
    const map = await decode(row, 'map');
    check(map && ['available', 'unavailable'].includes(map.status)
      && (map.status === 'available' ? map.geojson?.type === 'FeatureCollection'
        && Array.isArray(map.geojson.features) : map.geojson === null), 'storage_conflict');
    return Object.freeze({ preview, parcel_map: map });
  };
  return Object.freeze({
    read,
    async put(preview, parcelMap) {
      check(isCustomCohortObservationPreview(preview) && preview.preview_version === 2
        && canonicalAssessmentJson(preview.context_ref) === canonicalAssessmentJson(context)
        && matchesScope(preview),
      'prepared_index_required');
      check(parcelMap && ['available', 'unavailable'].includes(parcelMap.status),
        'map_required');
      const [storedPreview, storedMap] = await Promise.all([encode(preview, 'preview'), encode(parcelMap, 'map')]);
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
  const features = map.geojson.features.map(feature => ({ ...feature,
    properties: { ...feature.properties, selected: selected.has(feature.properties.account_id) } }));
  for (const feature of features) represented.add(feature.properties.account_id);
  check([...selected].every(account => represented.has(account)), 'map_membership_mismatch');
  const geojson = { ...map.geojson, features };
  const geojsonBytes = Buffer.byteLength(JSON.stringify(geojson));
  check(geojsonBytes <= 32_000_000, 'map_capacity_exceeded');
  return { ...map, geojson,
    counts: { ...map.counts, selected_accounts: selected.size, geojson_bytes: geojsonBytes } };
}
