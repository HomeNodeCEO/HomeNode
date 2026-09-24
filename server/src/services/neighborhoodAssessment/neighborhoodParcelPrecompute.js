// Reusable, *derived* CAD geometry. This never grants MLS access or creates
// appraisal evidence. A report may use a row only when its CAD MVCC version and
// source hash still match inside the report's read-only snapshot; otherwise its
// existing PostGIS expression runs against the original parcel row.
const LOCK_KEY = 3_603_600_823;
const BATCH_SQL = `WITH batch AS MATERIALIZED (
  SELECT parcel.object_id, parcel.xmin::text AS row_xmin,
    parcel.source_record_hash, parcel.geom,
    prepared.row_xmin AS prepared_xmin,
    prepared.source_record_hash AS prepared_hash
  FROM gis.dcad_parcels parcel
  LEFT JOIN app.neighborhood_parcel_precompute prepared USING (object_id)
  WHERE parcel.object_id > $1::bigint
  ORDER BY parcel.object_id LIMIT $2::integer
), encoded AS MATERIALIZED (
  SELECT object_id, row_xmin, source_record_hash, ST_AsEWKB(geom) AS ewkb
  FROM batch WHERE source_record_hash IS NOT NULL AND geom IS NOT NULL AND
    (row_xmin IS DISTINCT FROM prepared_xmin
      OR source_record_hash IS DISTINCT FROM prepared_hash)
), refreshed AS (
  INSERT INTO app.neighborhood_parcel_precompute
    (object_id, row_xmin, source_record_hash, geometry_sha256, stored_geometry_ewkb, computed_at)
  SELECT object_id, row_xmin, source_record_hash,
    encode(sha256(ewkb), 'hex'), encode(ewkb, 'hex'), now() FROM encoded
  ON CONFLICT (object_id) DO UPDATE SET
    row_xmin = EXCLUDED.row_xmin,
    source_record_hash = EXCLUDED.source_record_hash,
    geometry_sha256 = EXCLUDED.geometry_sha256,
    stored_geometry_ewkb = EXCLUDED.stored_geometry_ewkb,
    computed_at = EXCLUDED.computed_at
  RETURNING object_id
)
SELECT COALESCE((SELECT max(object_id) FROM batch), $1::bigint)::text AS last_object_id,
  (SELECT count(*) FROM batch)::integer AS scanned,
  (SELECT count(*) FROM refreshed)::integer AS refreshed`;
const PRUNE_SQL = `WITH stale AS (
  SELECT prepared.object_id FROM app.neighborhood_parcel_precompute prepared
  WHERE NOT EXISTS (SELECT 1 FROM gis.dcad_parcels parcel WHERE parcel.object_id = prepared.object_id)
  ORDER BY prepared.object_id LIMIT $1::integer
), removed AS (
  DELETE FROM app.neighborhood_parcel_precompute prepared
  USING stale WHERE prepared.object_id = stale.object_id RETURNING prepared.object_id
) SELECT count(*)::integer AS removed FROM removed`;

const validInteger = (value, maximum, name) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`invalid_neighborhood_precompute:${name}`);
  return value;
};

/** Run in a separate cron/worker process, never in the HTTP request handler.
 * A session advisory lock prevents overlapping executions. Every batch is one
 * atomic statement and a crash cannot expose half-written cache entries. */
export async function runNeighborhoodParcelPrecompute(pool, {
  batchSize = 500, maximumRuntimeMinutes = 45, logger = console,
} = {}) {
  validInteger(batchSize, 2000, 'batch_size');
  validInteger(maximumRuntimeMinutes, 720, 'maximum_runtime_minutes');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('neighborhood_precompute_pool_required');
  const client = await pool.connect();
  let locked = false;
  const started = Date.now();
  let scanned = 0, refreshed = 0, removed = 0, cursor = '-9223372036854775808';
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [LOCK_KEY]);
    locked = lock.rows?.[0]?.locked === true;
    if (!locked) return { status: 'already_running', scanned: 0, refreshed: 0, removed: 0 };
    await client.query(`INSERT INTO app.neighborhood_parcel_precompute_state
      (id, status, started_at, completed_at, rows_scanned, rows_refreshed, last_error_code, updated_at)
      VALUES (true, 'running', now(), NULL, 0, 0, NULL, now())
      ON CONFLICT (id) DO UPDATE SET status='running', started_at=now(), completed_at=NULL,
        rows_scanned=0, rows_refreshed=0, last_error_code=NULL, updated_at=now()`);
    const checkDeadline = () => {
      if (Date.now() - started >= maximumRuntimeMinutes * 60_000) {
        const error = new Error('neighborhood_precompute_runtime_limit');
        error.code = 'RUNTIME_LIMIT';
        throw error;
      }
    };
    for (;;) {
      checkDeadline();
      const result = await client.query({ text: BATCH_SQL, values: [cursor, batchSize],
        query_timeout: 60_000 });
      const row = result.rows?.[0];
      if (!row || !Number.isSafeInteger(row.scanned) || !Number.isSafeInteger(row.refreshed)
        || row.scanned < 0 || row.scanned > batchSize || row.refreshed < 0 || row.refreshed > row.scanned
        || typeof row.last_object_id !== 'string' || !/^-?\d+$/.test(row.last_object_id)
        || BigInt(row.last_object_id) < BigInt(cursor)) throw new Error('neighborhood_precompute_result_invalid');
      scanned += row.scanned; refreshed += row.refreshed;
      if (row.scanned === 0) break;
      if (BigInt(row.last_object_id) === BigInt(cursor)) throw new Error('neighborhood_precompute_cursor_stalled');
      cursor = row.last_object_id;
      if (scanned % (batchSize * 20) === 0) {
        await client.query(`UPDATE app.neighborhood_parcel_precompute_state
          SET rows_scanned=$1, rows_refreshed=$2, updated_at=now() WHERE id=true`, [scanned, refreshed]);
        logger.info?.(`[neighborhood-precompute] scanned=${scanned} refreshed=${refreshed}`);
      }
    }
    for (;;) {
      checkDeadline();
      const result = await client.query({ text: PRUNE_SQL, values: [batchSize], query_timeout: 60_000 });
      const count = result.rows?.[0]?.removed;
      if (!Number.isSafeInteger(count) || count < 0 || count > batchSize) throw new Error('neighborhood_precompute_prune_invalid');
      removed += count;
      if (count < batchSize) break;
    }
    await client.query(`UPDATE app.neighborhood_parcel_precompute_state
      SET status='complete', completed_at=now(), rows_scanned=$1, rows_refreshed=$2,
        last_error_code=NULL, updated_at=now() WHERE id=true`, [scanned, refreshed]);
    return { status: 'complete', scanned, refreshed, removed };
  } catch (error) {
    if (locked) {
      const code = /^[A-Z0-9_]{1,32}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_ERROR';
      try {
        await client.query(`UPDATE app.neighborhood_parcel_precompute_state
          SET status='failed', completed_at=now(), rows_scanned=$1, rows_refreshed=$2,
            last_error_code=$3, updated_at=now() WHERE id=true`, [scanned, refreshed, code]);
      } catch { /* Preserve the original failure; the next run can recover. */ }
    }
    throw error;
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]); }
      catch { /* A lost connection also releases its session lock. */ }
    }
    client.release();
  }
}

export const NEIGHBORHOOD_PRECOMPUTE_SQL = Object.freeze({ batch: BATCH_SQL, prune: PRUNE_SQL });
