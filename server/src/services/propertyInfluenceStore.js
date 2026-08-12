import { ensurePropertyContextSchema } from "./propertyContextStore.js";

function normalizedAccountIds(values, maximum = 10_000) {
  return [...new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter((value) => /^[0-9A-Za-z]{17}$/.test(value)))]
    .slice(0, maximum);
}

function response(row) {
  if (!row) return null;
  return {
    account_id: row.account_id,
    parcel_object_id: row.parcel_object_id == null ? null : Number(row.parcel_object_id),
    methodology_version: Number(row.methodology_version),
    spatial_context: row.spatial_context || {},
    influence_signature: row.influence_signature || {},
    material_influence_present: Boolean(row.material_influence_present),
    dominant_influence_key: row.dominant_influence_key || "ordinary_location",
    material_keys: row.material_keys || [],
    material_categories: row.material_categories || [],
    source_state: row.source_state || {},
    computed_at: row.computed_at,
    updated_at: row.updated_at,
  };
}

export async function savePropertyInfluenceContext(pool, {
  accountId,
  spatialContext,
  influenceSignature,
  sourceHealth = [],
  computedAt = new Date().toISOString(),
} = {}) {
  await ensurePropertyContextSchema(pool);
  const normalizedAccountId = String(accountId || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(normalizedAccountId)) {
    throw new Error("invalid_account_id");
  }
  const signature = influenceSignature || {};
  const sourceState = Object.fromEntries(
    (sourceHealth || []).map((source) => [source.source_key, {
      status: source.status,
      usable: source.usable,
      serving_stale_data: source.serving_stale_data,
      last_success_at: source.last_success_at,
      source_vintage: source.source_vintage,
    }]),
  );
  const { rows } = await pool.query(
    `INSERT INTO gis.property_influence_contexts (
       account_id, parcel_object_id, methodology_version, spatial_context,
       influence_signature, material_influence_present,
       dominant_influence_key, material_keys, material_categories,
       source_state, computed_at
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9::text[],$10::jsonb,$11::timestamptz)
     ON CONFLICT (account_id) DO UPDATE SET
       parcel_object_id = EXCLUDED.parcel_object_id,
       methodology_version = EXCLUDED.methodology_version,
       spatial_context = EXCLUDED.spatial_context,
       influence_signature = EXCLUDED.influence_signature,
       material_influence_present = EXCLUDED.material_influence_present,
       dominant_influence_key = EXCLUDED.dominant_influence_key,
       material_keys = EXCLUDED.material_keys,
       material_categories = EXCLUDED.material_categories,
       source_state = EXCLUDED.source_state,
       computed_at = EXCLUDED.computed_at,
       updated_at = now()
     RETURNING *`,
    [
      normalizedAccountId,
      spatialContext?.parcel_object_id || null,
      Number(signature.methodology_version || 2),
      JSON.stringify(spatialContext || {}),
      JSON.stringify(signature),
      Boolean(signature.material_influence_present),
      signature.dominant_influence_key || "ordinary_location",
      signature.material_keys || [],
      signature.material_categories || [],
      JSON.stringify(sourceState),
      computedAt,
    ],
  );
  return response(rows[0]);
}

export async function getPropertyInfluenceContexts(pool, accountIds) {
  await ensurePropertyContextSchema(pool);
  const ids = normalizedAccountIds(accountIds);
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT *
     FROM gis.property_influence_contexts
     WHERE account_id = ANY($1::text[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.account_id, response(row)]));
}

export async function enqueuePropertyInfluenceAccounts(pool, accounts, {
  reason = "property_context_requested",
  priority = 50,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const ids = normalizedAccountIds(
    (accounts || []).map((account) => account?.account_id ?? account),
  );
  if (!ids.length) return { queued: 0 };
  const { rowCount } = await pool.query(
    `INSERT INTO gis.property_influence_queue (
       account_id, reason, priority, status, available_at
     )
     SELECT account_id, $2, $3, 'pending', now()
     FROM unnest($1::text[]) AS account_id
     ON CONFLICT (account_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       priority = GREATEST(gis.property_influence_queue.priority, EXCLUDED.priority),
       status = CASE
         WHEN gis.property_influence_queue.status = 'processing'
           THEN gis.property_influence_queue.status
         ELSE 'pending'
       END,
       available_at = CASE
         WHEN gis.property_influence_queue.status = 'processing'
           THEN gis.property_influence_queue.available_at
         ELSE now()
       END,
       updated_at = now(),
       completed_at = NULL`,
    [ids, String(reason).slice(0, 200), Number(priority) || 50],
  );
  return { queued: rowCount || ids.length };
}

export async function seedPropertyInfluenceQueue(pool, { limit = 10_000 } = {}) {
  await ensurePropertyContextSchema(pool);
  const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(Number(limit) || 10_000)));
  const { rowCount } = await pool.query(
    `WITH road_state AS (
       SELECT MAX(last_success_at) AS refreshed_at
       FROM gis.source_sync_state
       WHERE source_key IN ('tiger_roads_primary', 'tiger_roads_secondary',
                            'tiger_roads_local', 'tiger_railroads', 'fema_nfhl',
                            'zoning_city_dallas_official',
                            'zoning_city_garland_official')
     ), candidates AS (
       SELECT sale.primary_account_id AS account_id,
              100 AS priority, 'matched_sale_inventory'::text AS reason
       FROM core.v_sales_enriched sale
       WHERE sale.primary_account_id IS NOT NULL
       GROUP BY sale.primary_account_id
       UNION ALL
       SELECT file.account_id, 90, 'appraisal_assignment'
       FROM app.assignment_files file
       GROUP BY file.account_id
       UNION ALL
       SELECT assessment.account_id, 80, 'complexity_assessment'
       FROM app.property_complexity_assessments assessment
       GROUP BY assessment.account_id
     ), prioritized AS (
       SELECT candidate.account_id,
              MAX(candidate.priority)::integer AS priority,
              (array_agg(candidate.reason ORDER BY candidate.priority DESC))[1] AS reason
       FROM candidates candidate
       WHERE candidate.account_id ~ '^[0-9A-Za-z]{17}$'
       GROUP BY candidate.account_id
     ), stale AS (
       SELECT prioritized.*
       FROM prioritized
       LEFT JOIN gis.property_influence_contexts context
         ON context.account_id = prioritized.account_id
       LEFT JOIN LATERAL (
         SELECT MAX(parcel.synced_at) AS refreshed_at
         FROM gis.dcad_parcels parcel
         WHERE parcel.account_id = prioritized.account_id
            OR parcel.low_parcel_id = prioritized.account_id
       ) parcel_state ON TRUE
       CROSS JOIN road_state
       WHERE context.account_id IS NULL
          OR context.methodology_version < 2
          OR context.computed_at < COALESCE(parcel_state.refreshed_at, '-infinity'::timestamptz)
          OR context.computed_at < COALESCE(road_state.refreshed_at, '-infinity'::timestamptz)
       ORDER BY prioritized.priority DESC, prioritized.account_id
       LIMIT $1
     )
     INSERT INTO gis.property_influence_queue (
       account_id, reason, priority, status, available_at
     )
     SELECT account_id, reason, priority, 'pending', now()
     FROM stale
     ON CONFLICT (account_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       priority = GREATEST(gis.property_influence_queue.priority, EXCLUDED.priority),
       status = CASE
         WHEN gis.property_influence_queue.status = 'processing'
           THEN gis.property_influence_queue.status
         ELSE 'pending'
       END,
       available_at = CASE
         WHEN gis.property_influence_queue.status = 'processing'
           THEN gis.property_influence_queue.available_at
         ELSE now()
       END,
       updated_at = now(),
       completed_at = NULL`,
    [safeLimit],
  );
  return { queued: rowCount || 0 };
}

export async function claimPropertyInfluenceQueue(pool, {
  batchSize = 100,
  workerId,
} = {}) {
  const safeBatchSize = Math.max(1, Math.min(500, Math.trunc(Number(batchSize) || 100)));
  const { rows } = await pool.query(
    `WITH claim AS (
       SELECT account_id
       FROM gis.property_influence_queue
       WHERE status IN ('pending', 'retry')
         AND available_at <= now()
       ORDER BY priority DESC, updated_at, account_id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE gis.property_influence_queue queue
     SET status = 'processing', attempts = attempts + 1,
         locked_at = now(), locked_by = $2, updated_at = now()
     FROM claim
     WHERE queue.account_id = claim.account_id
     RETURNING queue.account_id, queue.reason, queue.priority, queue.attempts`,
    [safeBatchSize, workerId],
  );
  return rows;
}

export async function recoverStalePropertyInfluenceClaims(pool, {
  olderThanMinutes = 30,
} = {}) {
  const safeMinutes = Math.max(5, Math.min(240, Math.trunc(Number(olderThanMinutes) || 30)));
  const { rowCount } = await pool.query(
    `UPDATE gis.property_influence_queue
     SET status = 'retry', available_at = now(), locked_at = NULL,
         locked_by = NULL, updated_at = now(),
         last_error = COALESCE(last_error, 'stale_worker_claim_recovered')
     WHERE status = 'processing'
       AND locked_at < now() - ($1::text || ' minutes')::interval`,
    [safeMinutes],
  );
  return rowCount || 0;
}

export async function completePropertyInfluenceQueueItem(pool, accountId) {
  await pool.query(
    `UPDATE gis.property_influence_queue
     SET status = 'completed', completed_at = now(), updated_at = now(),
         locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE account_id = $1`,
    [accountId],
  );
}

export async function failPropertyInfluenceQueueItem(pool, {
  accountId,
  attempts,
  maximumAttempts = 5,
  error,
} = {}) {
  const manualReview = Number(attempts || 0) >= Number(maximumAttempts || 5);
  const delayMinutes = Math.min(360, 2 ** Math.max(0, Number(attempts || 1) - 1) * 5);
  await pool.query(
    `UPDATE gis.property_influence_queue
     SET status = $2,
         available_at = CASE WHEN $2 = 'retry'
           THEN now() + ($3::text || ' minutes')::interval
           ELSE available_at END,
         last_error = $4, locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE account_id = $1`,
    [
      accountId,
      manualReview ? "manual_review" : "retry",
      delayMinutes,
      String(error?.message || error || "property_influence_failed").slice(0, 4_000),
    ],
  );
  return manualReview ? "manual_review" : "retry";
}

export async function getPropertyInfluenceStatus(pool) {
  await ensurePropertyContextSchema(pool);
  const { rows } = await pool.query(
    `WITH queue AS (
       SELECT status, COUNT(*)::integer AS count
       FROM gis.property_influence_queue
       GROUP BY status
     ), sales AS (
       SELECT DISTINCT primary_account_id AS account_id
       FROM core.v_sales_enriched
       WHERE primary_account_id IS NOT NULL
     )
     SELECT
       (SELECT COALESCE(jsonb_object_agg(status, count), '{}'::jsonb) FROM queue) AS queue,
       (SELECT COUNT(*)::integer FROM sales) AS sale_account_count,
       (SELECT COUNT(*)::integer
        FROM sales JOIN gis.property_influence_contexts context USING (account_id)) AS measured_sale_account_count` ,
  );
  const row = rows[0] || {};
  const saleCount = Number(row.sale_account_count || 0);
  const measured = Number(row.measured_sale_account_count || 0);
  return {
    queue: row.queue || {},
    coverage: {
      sale_account_count: saleCount,
      measured_sale_account_count: measured,
      missing_sale_account_count: Math.max(0, saleCount - measured),
      coverage_percent: saleCount ? Math.round(measured / saleCount * 10_000) / 100 : 0,
    },
  };
}

export async function getZoningSourceRegistry(pool) {
  await ensurePropertyContextSchema(pool);
  const { rows } = await pool.query(
    `SELECT provider_key, provider_label, provider_type, jurisdiction, priority,
            status, service_url, last_success_at, last_error, updated_at
     FROM gis.zoning_source_registry
     ORDER BY jurisdiction, priority DESC, provider_key`,
  );
  return rows.map((row) => ({
    ...row,
    priority: Number(row.priority),
    configured: row.status !== "pending_credentials",
    request_path_dependency: false,
  }));
}
