import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';

export const CUSTOM_COHORT_MAP_OPENING_BYTES = 4_000_000;
const compress = promisify(gzip), decompress = promisify(gunzip);
export const customCohortMapOpeningDigest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
function check(ok) { if (!ok) throw new TypeError('custom_cohort_prepared_map_opening_storage_conflict'); }

// The digest binds the whole immutable neutral catalog, including display labels.
// This cache cannot relabel another capture or substitute a selected subset.
export function checkCustomCohortPreparedMapOpening(manifest, payload, context, subject) {
  const catalog = payload?.catalog;
  check(catalog?.catalog_version === 3 && catalog.catalog_complete === true
    && catalog.authority === 'not_established' && catalog.apply?.status === 'blocked'
    && same(catalog.binding?.context_ref, context)
    && catalog.subject_membership?.account_id === subject
    && manifest && same(manifest.context_ref, context)
    && ['available', 'unavailable'].includes(manifest.status));
  if (manifest.status === 'unavailable') {
    check(typeof manifest.reason === 'string' && typeof manifest.geometry_semantics === 'string');
    return manifest;
  }
  const accounts = new Set(), groups = new Map();
  check(Array.isArray(catalog.pockets) && Array.isArray(catalog.unassigned?.account_ids));
  for (const pocket of catalog.pockets) {
    check(typeof pocket.id === 'string' && !groups.has(pocket.id) && Array.isArray(pocket.account_ids));
    groups.set(pocket.id, pocket);
    for (const account of pocket.account_ids) { check(typeof account === 'string' && !accounts.has(account)); accounts.add(account); }
  }
  for (const account of catalog.unassigned.account_ids) { check(typeof account === 'string' && !accounts.has(account)); accounts.add(account); }
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
  check(Array.isArray(manifest.bounds) && manifest.bounds.length === 2 && manifest.bounds.every(point)
    && typeof manifest.geometry_semantics === 'string'
    && manifest.bounds[0][0] <= manifest.bounds[1][0] && manifest.bounds[0][1] <= manifest.bounds[1][1]
    && manifest.labels?.type === 'FeatureCollection' && Array.isArray(manifest.labels.features)
    && Array.isArray(manifest.unlabelled_group_ids) && Array.isArray(manifest.subject_parcels)
    && manifest.counts?.captured_accounts === accounts.size
    && Number.isSafeInteger(manifest.counts.captured_parcels)
    && manifest.counts.captured_parcels >= accounts.size && manifest.counts.captured_parcels <= 100_000);
  const seen = new Set();
  const within = value => point(value) && value[0] >= manifest.bounds[0][0] && value[0] <= manifest.bounds[1][0]
    && value[1] >= manifest.bounds[0][1] && value[1] <= manifest.bounds[1][1];
  for (const label of manifest.labels.features) {
    const p = label?.properties, group = groups.get(p?.pocket_id);
    check(group && !seen.has(group.id) && label.type === 'Feature'
      && label.id === `custom-cohort-label:${group.id}` && label.geometry?.type === 'Point'
      && within(label.geometry.coordinates) && p.label === group.label && p.county === group.county
      && group.account_ids.includes(p.account_id) && /^gis\.dcad_parcels:[0-9]+$/.test(p.parcel_id)
      && p.anchor_basis === 'retained_exterior_ring_vertex');
    seen.add(group.id);
  }
  for (const id of manifest.unlabelled_group_ids) { check(groups.has(id) && !seen.has(id)); seen.add(id); }
  check(seen.size === groups.size);
  const parcels = new Set();
  for (const marker of manifest.subject_parcels) {
    check(marker.account_id === subject && accounts.has(subject) && within(marker.coordinates)
      && /^gis\.dcad_parcels:[0-9]+$/.test(marker.parcel_id) && !parcels.has(marker.parcel_id)
      && marker.anchor_basis === 'retained_exterior_ring_vertex');
    parcels.add(marker.parcel_id);
  }
  check(!accounts.has(subject) || parcels.size > 0);
  return manifest;
}

export async function encodeCustomCohortPreparedMapOpening(manifest) {
  const text = Buffer.from(JSON.stringify(manifest));
  if (!text.length || text.length > CUSTOM_COHORT_MAP_OPENING_BYTES)
    throw new TypeError('custom_cohort_prepared_map_opening_capacity_exceeded');
  const compressed = await compress(text, { level: 1 });
  if (!compressed.length || compressed.length > CUSTOM_COHORT_MAP_OPENING_BYTES)
    throw new TypeError('custom_cohort_prepared_map_opening_capacity_exceeded');
  return { digest: customCohortMapOpeningDigest(text), bytes: text.length, compressed };
}

/** Display read model only. The caller must first reload current assignment,
 * original-context and source rights, and must perform its final subject/role
 * recheck. No map blob crosses this boundary; actual original compressed-byte
 * hashes are still checked in PostgreSQL. Missing/unsupported sidecars keep the
 * legacy full-map fallback. Corrupt or detached sidecars fail closed. */
export function createCustomCohortPreparedMapOpeningRepository(client, scopeJson, contextRef) {
  check(typeof client?.query === 'function');
  const scope = prepareCustomCohortContextScope(scopeJson);
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(contextRef));
  return Object.freeze({ async read(payload) {
    // Pin the already-checked catalog bytes before any database/decompression
    // wait. A later caller mutation cannot change which immutable display
    // binding is validated after the original-source hashes have succeeded.
    const catalogText = JSON.stringify(payload);
    check(typeof catalogText === 'string' && Buffer.byteLength(catalogText) <= CUSTOM_COHORT_MAP_OPENING_BYTES);
    const capturedPayload = JSON.parse(catalogText), catalogDigest = customCohortMapOpeningDigest(catalogText);
    const found = await client.query(`/* custom-cohort-prepared-map-opening:read */
      SELECT m.*, p.preview_sha256 AS current_preview_sha256, p.map_sha256 AS current_map_sha256,
        c.payload_sha256 AS current_catalog_sha256,
        pg_catalog.encode(pg_catalog.sha256(c.compressed_payload), 'hex') AS current_compressed_catalog_sha256,
        pg_catalog.encode(pg_catalog.sha256(p.compressed_preview), 'hex') AS current_compressed_preview_sha256,
        pg_catalog.encode(pg_catalog.sha256(p.compressed_map), 'hex') AS current_compressed_map_sha256
      FROM app.neighborhood_custom_cohort_prepared_map_openings m
      JOIN app.neighborhood_custom_cohort_contexts o
        ON o.organization_id=m.organization_id AND o.context_id=m.context_id
        AND o.context_sha256=m.context_sha256
      JOIN app.neighborhood_custom_cohort_prepared_previews p
        ON p.organization_id=m.organization_id AND p.context_id=m.context_id
        AND p.context_sha256=m.context_sha256 AND p.format_version=m.format_version
      JOIN app.neighborhood_custom_cohort_prepared_catalogs c
        ON c.organization_id=m.organization_id AND c.context_id=m.context_id
        AND c.context_sha256=m.context_sha256 AND c.format_version=m.format_version
        AND c.catalog_version=m.catalog_version
      WHERE m.organization_id=$1::uuid AND m.context_id=$2::uuid
        AND m.context_sha256=$3 AND m.format_version=1 AND m.catalog_version=3
        AND o.report_file_id=$4::uuid AND o.assignment_file_id=$5::bigint AND o.account_id=$6`,
    [scope.organization_id, context.context_id, context.context_sha256,
      scope.report_file_id, scope.assignment_file_id, scope.account_id]);
    check(found && [0, 1].includes(found.rowCount) && Array.isArray(found.rows) && found.rows.length === found.rowCount);
    if (!found.rowCount) return null;
    const row = found.rows[0];
    for (const kind of ['catalog', 'compressed_catalog', 'preview', 'compressed_preview', 'map', 'compressed_map'])
      check(/^[a-f0-9]{64}$/.test(row[`source_${kind}_sha256`])
        && row[`source_${kind}_sha256`] === row[`current_${kind}_sha256`]);
    check(row.source_catalog_sha256 === catalogDigest);
    if (row.status === 'unavailable') {
      check(['capacity_exceeded', 'source_invalid', 'catalog_geometry_mismatch'].includes(row.reason)
        && row.payload_sha256 === null && row.payload_utf8_bytes === null && row.compressed_payload === null);
      return null;
    }
    check(row.status === 'available' && row.reason === null && /^[a-f0-9]{64}$/.test(row.payload_sha256)
      && Number.isSafeInteger(row.payload_utf8_bytes) && row.payload_utf8_bytes > 0
      && row.payload_utf8_bytes <= CUSTOM_COHORT_MAP_OPENING_BYTES
      && Buffer.isBuffer(row.compressed_payload) && row.compressed_payload.length > 0
      && row.compressed_payload.length <= CUSTOM_COHORT_MAP_OPENING_BYTES);
    let text, manifest;
    try { text = await decompress(row.compressed_payload, { maxOutputLength: CUSTOM_COHORT_MAP_OPENING_BYTES });
      manifest = JSON.parse(text.toString('utf8')); } catch { check(false); }
    check(text.length === row.payload_utf8_bytes && customCohortMapOpeningDigest(text) === row.payload_sha256);
    return checkCustomCohortPreparedMapOpening(manifest, capturedPayload, context, scope.account_id);
  } });
}
