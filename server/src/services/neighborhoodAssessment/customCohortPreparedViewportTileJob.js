import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { buildCustomCohortPreparedViewportTiles } from './customCohortPreparedViewportTiles.js';

const decompress = promisify(gunzip);
const digest = value => createHash('sha256').update(value).digest('hex');
const LIMITS = Object.freeze({ preview: { text: 64_000_000, compressed: 12_000_000 },
  map: { text: 32_000_000, compressed: 16_000_000 } });
function fail(reason) { throw new TypeError(`custom_cohort_prepared_tiles_${reason}`); }
function check(value, reason) { if (!value) fail(reason); }
async function decode(row, kind) {
  const bytes = row[`${kind}_utf8_bytes`], compressed = row[`compressed_${kind}`];
  check(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= LIMITS[kind].text
    && Buffer.isBuffer(compressed) && compressed.length > 0
    && compressed.length <= LIMITS[kind].compressed, 'source_conflict');
  let text;
  try { text = await decompress(compressed, { maxOutputLength: LIMITS[kind].text }); }
  catch { fail('source_conflict'); }
  check(text.length === bytes && digest(text) === row[`${kind}_sha256`], 'source_conflict');
  try { return JSON.parse(text.toString('utf8')); }
  catch { fail('source_conflict'); }
}

/** A separate maintenance worker publishes one complete derived tile set in
 * one transaction. It never mutates the original capture or an accepted report. */
export async function runCustomCohortPreparedViewportTileJob(pool, {
  maximumContexts = 10, maximumRuntimeMinutes = 80, logger = console,
} = {}) {
  check(pool && typeof pool.connect === 'function'
    && Number.isSafeInteger(maximumContexts) && maximumContexts >= 1 && maximumContexts <= 100
    && Number.isSafeInteger(maximumRuntimeMinutes) && maximumRuntimeMinutes >= 1
    && maximumRuntimeMinutes <= 180, 'invalid_job');
  const deadline = Date.now() + maximumRuntimeMinutes * 60_000;
  const client = await pool.connect();
  let locked = false, completed = 0, unavailable = 0, tiles = 0;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('homenode-custom-cohort-prepared-tiles-v1')) AS locked");
    locked = lock?.rows?.[0]?.locked === true;
    if (!locked) return Object.freeze({ status: 'already_running', completed: 0, unavailable: 0, tiles: 0 });
    while (completed + unavailable < maximumContexts && Date.now() < deadline) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout = '120s'");
        const next = await client.query(`/* custom-cohort-prepared-tiles:next */
          SELECT p.organization_id, p.context_id, p.context_sha256,
            p.preview_sha256, p.preview_utf8_bytes, p.compressed_preview,
            p.map_sha256, p.map_utf8_bytes, p.compressed_map
          FROM app.neighborhood_custom_cohort_prepared_previews p
          LEFT JOIN app.neighborhood_custom_cohort_prepared_tile_manifests m
            ON m.organization_id=p.organization_id AND m.context_id=p.context_id
            AND m.format_version=1
          WHERE p.format_version=1 AND m.context_id IS NULL
          ORDER BY p.prepared_at, p.context_id LIMIT 1`);
        check(next && [0, 1].includes(next.rowCount), 'source_conflict');
        if (!next.rowCount) { await client.query('COMMIT'); break; }
        const row = next.rows[0], preview = await decode(row, 'preview'), map = await decode(row, 'map');
        check(preview?.preview_version === 2 && preview.context_ref?.context_id === row.context_id
          && preview.context_ref?.context_sha256 === row.context_sha256
          && map && ['available', 'unavailable'].includes(map.status), 'source_conflict');
        if (map.status === 'available') {
          check(map.geojson?.type === 'FeatureCollection'
            && Buffer.byteLength(JSON.stringify(map.geojson)) === map.counts?.geojson_bytes,
          'source_conflict');
        }
        let built = null, reason = null;
        if (map.status === 'unavailable') reason = 'source_unavailable';
        else {
          try { built = await buildCustomCohortPreparedViewportTiles(preview, map); }
          catch (error) {
            const code = error?.message?.replace(/^custom_cohort_prepared_tiles_/, '');
            if (code === 'capacity_exceeded' || code === 'membership_mismatch') reason = code;
            else throw error;
          }
        }
        check(Date.now() < deadline, 'time_budget_exceeded');
        const fields = [row.organization_id, row.context_id, row.context_sha256,
          row.preview_sha256, row.map_sha256, digest(row.compressed_map),
          built ? 'available' : 'unavailable', reason,
          built?.captured_parcels ?? null, built?.account_set_sha256 ?? null,
          built?.map_shell_json ?? null, built?.map_shell_sha256 ?? null,
          built?.cell_keys_json ?? null];
        await client.query(`/* custom-cohort-prepared-tiles:manifest */
          INSERT INTO app.neighborhood_custom_cohort_prepared_tile_manifests
            (organization_id, context_id, format_version, context_sha256,
             source_preview_sha256, source_map_sha256, source_compressed_map_sha256,
             status, reason, captured_parcels, account_set_sha256, map_shell_json,
             map_shell_sha256, cell_keys_json)
          VALUES ($1::uuid,$2::uuid,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, fields);
        for (const tile of built?.tiles ?? []) {
          await client.query(`/* custom-cohort-prepared-tiles:tile */
            INSERT INTO app.neighborhood_custom_cohort_prepared_tiles
              (organization_id, context_id, format_version, cell_x, cell_y,
               tile_sha256, tile_utf8_bytes, compressed_tile)
            VALUES ($1::uuid,$2::uuid,1,$3,$4,$5,$6,$7)`, [row.organization_id, row.context_id,
            tile.cell_x, tile.cell_y, tile.sha256, tile.utf8_bytes, tile.compressed]);
        }
        check(Date.now() < deadline, 'time_budget_exceeded');
        await client.query('COMMIT');
        if (built) { completed++; tiles += built.tiles.length; }
        else unavailable++;
        logger.info?.('[neighborhood-tiles] published', { status: built ? 'available' : 'unavailable',
          tile_count: built?.tiles.length ?? 0 });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      }
    }
    return Object.freeze({ status: 'complete', completed, unavailable, tiles });
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('homenode-custom-cohort-prepared-tiles-v1'))"); }
      catch { /* Session release also releases this lock. */ }
    }
    client.release();
  }
}
