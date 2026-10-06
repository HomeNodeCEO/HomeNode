import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { buildCustomCohortMapManifest } from './customCohortMapManifest.js';
import { createCustomCohortPreparedCatalogRepository } from './customCohortPreparedCatalogRepository.js';
import { checkCustomCohortPreparedMapOpening, encodeCustomCohortPreparedMapOpening,
  customCohortMapOpeningDigest as digest } from './customCohortPreparedMapOpeningRepository.js';

const decompress = promisify(gunzip);
const LIMITS = Object.freeze({ preview: [64_000_000, 12_000_000], map: [32_000_000, 16_000_000] });
function check(ok) { if (!ok) throw new TypeError('custom_cohort_prepared_map_opening_source_invalid'); }
async function decode(row, kind) {
  const bytes = row[`${kind}_utf8_bytes`], packed = row[`compressed_${kind}`], [expanded, compressed] = LIMITS[kind];
  check(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= expanded
    && Buffer.isBuffer(packed) && packed.length > 0 && packed.length <= compressed);
  let text;
  try { text = await decompress(packed, { maxOutputLength: expanded }); } catch { check(false); }
  check(text.length === bytes && digest(text) === row[`${kind}_sha256`]);
  try { return JSON.parse(text.toString('utf8')); } catch { check(false); }
}

/** Separate bounded maintenance pass: derive only compact labels/bounds/subject
 * anchors from retained complete originals. No provider calls, original updates,
 * source grants, selected membership, genuine files or accepted-report writes. */
export async function runCustomCohortPreparedMapOpeningJob(pool, {
  maximumContexts = 10, maximumRuntimeMinutes = 80, logger = console,
} = {}) {
  if (typeof pool?.connect !== 'function' || !Number.isSafeInteger(maximumContexts)
    || maximumContexts < 1 || maximumContexts > 100 || !Number.isSafeInteger(maximumRuntimeMinutes)
    || maximumRuntimeMinutes < 1 || maximumRuntimeMinutes > 180)
    throw new TypeError('custom_cohort_prepared_map_opening_invalid_job');
  const deadline = Date.now() + maximumRuntimeMinutes * 60_000, client = await pool.connect();
  let locked = false, completed = 0, unavailable = 0;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('homenode-custom-cohort-map-openings-v1')) AS locked"))?.rows?.[0]?.locked === true;
    if (!locked) return Object.freeze({ status: 'already_running', completed, unavailable });
    while (completed + unavailable < maximumContexts && Date.now() < deadline) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout = '120s'");
        const next = await client.query(`/* custom-cohort-prepared-map-opening:next */
          SELECT p.*, o.report_file_id, o.assignment_file_id::text, o.account_id,
            c.payload_sha256 AS catalog_sha256,
            pg_catalog.encode(pg_catalog.sha256(c.compressed_payload), 'hex') AS compressed_catalog_sha256
          FROM app.neighborhood_custom_cohort_prepared_previews p
          JOIN app.neighborhood_custom_cohort_contexts o ON o.organization_id=p.organization_id
            AND o.context_id=p.context_id AND o.context_sha256=p.context_sha256
          JOIN app.neighborhood_custom_cohort_prepared_catalogs c ON c.organization_id=p.organization_id
            AND c.context_id=p.context_id AND c.context_sha256=p.context_sha256
            AND c.format_version=p.format_version AND c.catalog_version=3
          LEFT JOIN app.neighborhood_custom_cohort_prepared_map_openings m
            ON m.organization_id=p.organization_id AND m.context_id=p.context_id AND m.format_version=1
          WHERE p.format_version=1 AND m.context_id IS NULL
          ORDER BY c.prepared_at, p.context_id LIMIT 1`);
        check(next && [0, 1].includes(next.rowCount) && Array.isArray(next.rows) && next.rows.length === next.rowCount);
        if (!next.rowCount) { await client.query('COMMIT'); break; }
        const row = next.rows[0], scope = Object.fromEntries(['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'].map(key => [key, row[key]]));
        let packed = null, reason = null;
        try {
          const preview = await decode(row, 'preview'), map = await decode(row, 'map');
          const context = preview?.context_ref;
          check(preview?.preview_version === 2 && context?.context_id === row.context_id
            && context?.context_sha256 === row.context_sha256
            && Object.keys(scope).every(key => preview.target?.[key] === scope[key])
            && Array.isArray(preview.all?.account_ids) && map && ['available', 'unavailable'].includes(map.status));
          const payload = await createCustomCohortPreparedCatalogRepository(client, canonicalAssessmentJson(scope), context).read();
          check(payload && digest(JSON.stringify(payload)) === row.catalog_sha256);
          const accounts = [...payload.catalog.pockets.flatMap(group => group.account_ids), ...payload.catalog.unassigned.account_ids].sort();
          check(canonicalAssessmentJson(accounts) === canonicalAssessmentJson([...preview.all.account_ids].sort())
            && new Set(accounts).size === accounts.length);
          if (map.status === 'available') check(map.geojson?.type === 'FeatureCollection'
            && Array.isArray(map.geojson.features)
            && Buffer.byteLength(JSON.stringify(map.geojson)) === map.counts?.geojson_bytes
            && map.geojson.features.every(feature => feature.properties?.selected === false));
          const manifest = buildCustomCohortMapManifest(payload.catalog, map);
          if (manifest.status === 'unavailable' && manifest.reason === 'catalog_geometry_mismatch') reason = manifest.reason;
          else packed = await encodeCustomCohortPreparedMapOpening(checkCustomCohortPreparedMapOpening(manifest, payload, context, scope.account_id));
        } catch (error) {
          if (error?.message === 'custom_cohort_prepared_map_opening_capacity_exceeded') reason = 'capacity_exceeded';
          else if (/^(custom_cohort_prepared_(map_opening|catalog)_|invalid_custom_cohort_map_manifest)/.test(error?.message ?? '')) reason = 'source_invalid';
          else throw error;
        }
        if (Date.now() >= deadline) throw new TypeError('custom_cohort_prepared_map_opening_time_budget_exceeded');
        // Complete derivative plus every original byte identity in one commit.
        // A rejected derivative records no partial labels and retains fallback.
        await client.query(`/* custom-cohort-prepared-map-opening:insert */
          INSERT INTO app.neighborhood_custom_cohort_prepared_map_openings
            (organization_id,context_id,format_version,catalog_version,context_sha256,
             source_catalog_sha256,source_compressed_catalog_sha256,source_preview_sha256,
             source_compressed_preview_sha256,source_map_sha256,source_compressed_map_sha256,
             status,reason,payload_sha256,payload_utf8_bytes,compressed_payload)
          VALUES ($1::uuid,$2::uuid,1,3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [row.organization_id, row.context_id, row.context_sha256, row.catalog_sha256,
          row.compressed_catalog_sha256, row.preview_sha256, digest(row.compressed_preview),
          row.map_sha256, digest(row.compressed_map), packed ? 'available' : 'unavailable', reason,
          packed?.digest ?? null, packed?.bytes ?? null, packed?.compressed ?? null]);
        if (Date.now() >= deadline) throw new TypeError('custom_cohort_prepared_map_opening_time_budget_exceeded');
        await client.query('COMMIT');
        if (packed) completed++; else unavailable++;
        // Operational logging is not part of derivative publication or recovery.
        try { Promise.resolve(logger.info?.('[neighborhood-map-openings] published', { status: packed ? 'available' : 'unavailable' })).catch(() => {}); } catch {}
      } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    }
    return Object.freeze({ status: 'complete', completed, unavailable });
  } finally {
    if (locked) { try { await client.query("SELECT pg_advisory_unlock(hashtext('homenode-custom-cohort-map-openings-v1'))"); } catch {} }
    client.release();
  }
}
