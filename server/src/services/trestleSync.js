import { createHash } from "node:crypto";

import {
  ensureProviderIngestionSchema,
  runProviderPostIngestBatch,
  upsertProviderRawRecords,
} from "./providerIngestion.js";
import { TrestleClient } from "./trestleClient.js";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function errorMessage(error) {
  return String(error?.message || error || "trestle_sync_failed").slice(0, 4_000);
}

function latestModification(records, current = null) {
  let latest = current ? new Date(current) : null;
  for (const record of records) {
    if (!record?.ModificationTimestamp) continue;
    const parsed = new Date(record.ModificationTimestamp);
    if (!Number.isNaN(parsed.getTime()) && (!latest || parsed > latest)) latest = parsed;
  }
  return latest?.toISOString() || null;
}

async function syncState(pool, scopeKey) {
  const { rows } = await pool.query(
    `SELECT watermark, next_link, metadata_sha256
     FROM app.provider_sync_state
     WHERE provider = 'trestle' AND resource = 'Property' AND scope_key = $1`,
    [scopeKey],
  );
  return rows[0] || {};
}

async function saveSyncState(
  pool,
  scopeKey,
  { watermark = null, nextLink = null, metadataSha256 = null, error = null } = {},
) {
  await pool.query(
    `INSERT INTO app.provider_sync_state (
       provider, resource, scope_key, watermark, next_link,
       metadata_sha256, last_success_at, last_error, updated_at
     ) VALUES (
       'trestle','Property',$1,$2,$3,$4,
       CASE WHEN $5::text IS NULL THEN now() ELSE NULL END,$5,now()
     )
     ON CONFLICT (provider, resource, scope_key) DO UPDATE SET
       watermark = COALESCE(EXCLUDED.watermark, app.provider_sync_state.watermark),
       next_link = EXCLUDED.next_link,
       metadata_sha256 = COALESCE(EXCLUDED.metadata_sha256, app.provider_sync_state.metadata_sha256),
       last_success_at = CASE
         WHEN EXCLUDED.last_error IS NULL THEN now()
         ELSE app.provider_sync_state.last_success_at
       END,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [scopeKey, watermark, nextLink, metadataSha256, error],
  );
}

/**
 * Incrementally mirror licensed Trestle Property records. The raw mirror and
 * cursor are production-ready, while canonical sales/media activation remains
 * intentionally gated until the signed feed exposes its exact fields/rights.
 */
export async function runTrestleIncrementalSync(
  pool,
  {
    client = new TrestleClient(),
    scopeKey = client.config.originatingSystemName || "contract-default",
    maximumPages = 10,
    pageSize = client.config.pageSize,
    postIngestBatchesPerPage = 2,
    postIngestBatchSize = 500,
    logger = console,
  } = {},
) {
  const status = client.status();
  if (!status.ready) {
    throw new Error(status.enabled ? "trestle_credentials_missing" : "trestle_disabled");
  }
  await ensureProviderIngestionSchema(pool);
  const safePages = boundedInteger(maximumPages, 10, 1, 1_000);
  const safePageSize = boundedInteger(pageSize, 1_000, 1, 1_000);
  const safePostBatches = boundedInteger(postIngestBatchesPerPage, 2, 0, 20);
  const safePostBatchSize = boundedInteger(postIngestBatchSize, 500, 1, 500);
  const { rows: runRows } = await pool.query(
    `INSERT INTO app.provider_ingestion_runs (
       provider, resource, status, details
     ) VALUES ('trestle','Property','running',$1::jsonb)
     RETURNING id`,
    [JSON.stringify({ scope_key: scopeKey, maximum_pages: safePages, page_size: safePageSize })],
  );
  const runId = runRows[0]?.id;
  const totals = {
    run_id: runId,
    pages: 0,
    records_received: 0,
    records_changed: 0,
    records_queued: 0,
    post_ingest_claimed: 0,
    post_ingest_completed: 0,
    manual_review: 0,
  };
  let state = await syncState(pool, scopeKey);
  let nextLink = state.next_link || null;
  let watermark = state.watermark || null;
  try {
    const metadata = await client.metadata();
    const metadataSha256 = createHash("sha256").update(metadata).digest("hex");
    for (let pageNumber = 0; pageNumber < safePages; pageNumber += 1) {
      const page = await client.propertyPage({
        modifiedAfter: nextLink ? null : watermark,
        nextLink,
        pageSize: safePageSize,
      });
      const records = Array.isArray(page?.value) ? page.value : [];
      const stored = await upsertProviderRawRecords(pool, {
        provider: "trestle",
        resource: "Property",
        records,
        keyField: "ListingKey",
        ensureSchema: false,
      });
      totals.pages += 1;
      totals.records_received += stored.received;
      totals.records_changed += stored.changed;
      totals.records_queued += stored.queued;
      watermark = latestModification(records, watermark);
      nextLink = page?.["@odata.nextLink"] || null;
      await saveSyncState(pool, scopeKey, {
        watermark,
        nextLink,
        metadataSha256,
      });

      for (let batch = 0; batch < safePostBatches; batch += 1) {
        const processed = await runProviderPostIngestBatch(pool, {
          provider: "trestle",
          batchSize: safePostBatchSize,
          ensureSchema: false,
        });
        totals.post_ingest_claimed += processed.claimed;
        totals.post_ingest_completed += processed.completed;
        totals.manual_review += processed.manualReview;
        if (!processed.claimed) break;
      }
      if (!nextLink || !records.length) break;
    }
    await pool.query(
      `UPDATE app.provider_ingestion_runs
       SET status = 'completed', records_received = $2, records_changed = $3,
           records_processed = $4, manual_review_count = $5,
           finished_at = now(), details = details || $6::jsonb
       WHERE id = $1`,
      [runId, totals.records_received, totals.records_changed,
        totals.post_ingest_completed, totals.manual_review,
        JSON.stringify({ pages: totals.pages, next_link_pending: Boolean(nextLink), watermark })],
    );
    return { ok: true, ...totals, watermark, next_link_pending: Boolean(nextLink) };
  } catch (error) {
    const message = errorMessage(error);
    await saveSyncState(pool, scopeKey, { watermark, nextLink, error: message });
    await pool.query(
      `UPDATE app.provider_ingestion_runs
       SET status = 'failed', finished_at = now(), error_message = $2,
           records_received = $3, records_changed = $4,
           records_processed = $5, manual_review_count = $6
       WHERE id = $1`,
      [runId, message, totals.records_received, totals.records_changed,
        totals.post_ingest_completed, totals.manual_review],
    );
    logger.warn?.("[trestle-sync] failed; last good cursor retained", message);
    throw error;
  }
}
