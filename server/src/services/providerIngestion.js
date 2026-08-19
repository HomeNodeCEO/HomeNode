import { createHash, randomUUID } from "node:crypto";

import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
} from "./locationBackfillQueue.js";
import { ensurePropertyEnrichmentSchema } from "./propertyEnrichment.js";
import { mapTrestleProperty } from "./trestleClient.js";

function text(value) {
  return String(value ?? "").trim();
}

export function normalizedProviderCounty(value) {
  return text(value).toUpperCase().replace(/\s+COUNTY$/, "");
}

export function normalizedProviderParcelId(value, county = null) {
  let normalized = text(value).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (normalizedProviderCounty(county) === "COLLIN") normalized = normalized.replace(/^R/, "");
  return normalized;
}

export function normalizedProviderAddress(value) {
  return text(value)
    .split(",")[0]
    .toUpperCase()
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bCIRCLE\b/g, "CIR")
    .replace(/\bPARKWAY\b/g, "PKWY")
    .replace(/[^A-Z0-9]/g, "");
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function coordinate(value, kind) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const valid = kind === "latitude"
    ? parsed >= 25.5 && parsed <= 36.6
    : parsed >= -106.7 && parsed <= -93.4;
  return valid ? parsed : null;
}

export async function ensureProviderIngestionSchema(pool) {
  await ensureLocationBackfillQueueSchema(pool);
  await ensurePropertyEnrichmentSchema(pool);
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE OR REPLACE FUNCTION app.normalized_situs_key(value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    AS $$
      SELECT REGEXP_REPLACE(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          UPPER(SPLIT_PART(COALESCE(value, ''), ',', 1)),
          ' STREET', ' ST'), ' ROAD', ' RD'), ' LANE', ' LN'),
          ' DRIVE', ' DR'), ' AVENUE', ' AVE'), ' COURT', ' CT'),
          ' BOULEVARD', ' BLVD'), ' PARKWAY', ' PKWY'),
        '[^0-9A-Z]', '', 'g'
      )
    $$;

    CREATE TABLE IF NOT EXISTS app.parcel_match_cache (
      county_key            text NOT NULL,
      normalized_parcel_id text NOT NULL,
      account_id            text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      native_account_id     text NOT NULL,
      address_key           text,
      city_key              text,
      postal_code           text,
      latitude              double precision,
      longitude             double precision,
      location_source       text,
      refreshed_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (county_key, normalized_parcel_id)
    );
    CREATE INDEX IF NOT EXISTS parcel_match_cache_address_idx
      ON app.parcel_match_cache (county_key, city_key, address_key)
      WHERE address_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS parcel_match_cache_account_idx
      ON app.parcel_match_cache (account_id);

    CREATE OR REPLACE FUNCTION app.refresh_parcel_match_cache_account(target_account_id text)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO app.parcel_match_cache (
        county_key, normalized_parcel_id, account_id, native_account_id,
        address_key, city_key, postal_code, latitude, longitude,
        location_source, refreshed_at
      )
      SELECT
        UPPER(REGEXP_REPLACE(BTRIM(COALESCE(account.county, '')), '\\s+COUNTY$', '', 'i')),
        CASE
          WHEN account.county ILIKE '%collin%' THEN REGEXP_REPLACE(
            REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '^R', '', 'i'),
            '[^0-9A-Z]', '', 'g'
          )
          ELSE REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '[^0-9A-Z]', '', 'g')
        END,
        account.account_id,
        account.account_id,
        NULLIF(app.normalized_situs_key(account.address), ''),
        NULLIF(REGEXP_REPLACE(UPPER(COALESCE(account.city, '')), '[^0-9A-Z]', '', 'g'), ''),
        account.postal_code,
        location.latitude,
        location.longitude,
        location.source,
        now()
      FROM core.accounts account
      LEFT JOIN core.account_locations location ON location.account_id = account.account_id
      WHERE account.account_id = target_account_id
        AND NULLIF(BTRIM(account.county), '') IS NOT NULL
      ON CONFLICT (county_key, normalized_parcel_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        native_account_id = EXCLUDED.native_account_id,
        address_key = EXCLUDED.address_key,
        city_key = EXCLUDED.city_key,
        postal_code = EXCLUDED.postal_code,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        location_source = EXCLUDED.location_source,
        refreshed_at = now();
    END
    $$;

    CREATE OR REPLACE FUNCTION app.parcel_match_cache_account_trigger()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM app.refresh_parcel_match_cache_account(NEW.account_id);
      RETURN NEW;
    END
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'parcel_match_cache_accounts_sync'
          AND tgrelid = 'core.accounts'::regclass
      ) THEN
        CREATE TRIGGER parcel_match_cache_accounts_sync
          AFTER INSERT OR UPDATE OF account_id, county, address, city, postal_code
          ON core.accounts
          FOR EACH ROW EXECUTE FUNCTION app.parcel_match_cache_account_trigger();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'parcel_match_cache_locations_sync'
          AND tgrelid = 'core.account_locations'::regclass
      ) THEN
        CREATE TRIGGER parcel_match_cache_locations_sync
          AFTER INSERT OR UPDATE OF latitude, longitude, source, status
          ON core.account_locations
          FOR EACH ROW EXECUTE FUNCTION app.parcel_match_cache_account_trigger();
      END IF;
    END
    $$;

    CREATE TABLE IF NOT EXISTS app.provider_sync_state (
      provider                text NOT NULL,
      resource                text NOT NULL,
      scope_key               text NOT NULL DEFAULT 'default',
      watermark               timestamptz,
      next_link               text,
      metadata_sha256         text,
      last_success_at         timestamptz,
      last_error              text,
      updated_at              timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, resource, scope_key)
    );

    CREATE TABLE IF NOT EXISTS app.provider_ingestion_runs (
      id                      bigserial PRIMARY KEY,
      provider                text NOT NULL,
      resource                text NOT NULL,
      status                  text NOT NULL CHECK (status IN ('running','completed','failed')),
      records_received        integer NOT NULL DEFAULT 0,
      records_changed         integer NOT NULL DEFAULT 0,
      records_processed       integer NOT NULL DEFAULT 0,
      manual_review_count     integer NOT NULL DEFAULT 0,
      started_at              timestamptz NOT NULL DEFAULT now(),
      finished_at             timestamptz,
      details                 jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message           text
    );

    CREATE TABLE IF NOT EXISTS app.provider_raw_records (
      id                      bigserial PRIMARY KEY,
      provider                text NOT NULL,
      resource                text NOT NULL,
      provider_record_key     text NOT NULL,
      provider_modified_at    timestamptz,
      payload_sha256          text NOT NULL,
      raw_payload             jsonb NOT NULL,
      canonical_account_id    text REFERENCES core.accounts(account_id),
      account_match_method    text,
      account_matched_at      timestamptz,
      first_seen_at           timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, resource, provider_record_key)
    );
    CREATE INDEX IF NOT EXISTS provider_raw_records_account_idx
      ON app.provider_raw_records (canonical_account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS app.provider_post_ingest_queue (
      raw_record_id           bigint PRIMARY KEY
                              REFERENCES app.provider_raw_records(id) ON DELETE CASCADE,
      status                  text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','retry','completed','manual_review')),
      priority                smallint NOT NULL DEFAULT 0,
      attempts                integer NOT NULL DEFAULT 0,
      next_attempt_at         timestamptz NOT NULL DEFAULT now(),
      leased_at               timestamptz,
      worker_id               text,
      result                  jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_error              text,
      updated_at              timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS provider_post_ingest_queue_work_idx
      ON app.provider_post_ingest_queue (status, next_attempt_at, priority DESC)
      WHERE status IN ('pending','retry');
  `);
}

/**
 * Build the database-only parcel/address index used before any county GIS call.
 * The cache makes matching newly arrived MLS records essentially immediate.
 */
export async function refreshParcelMatchCache(
  pool,
  { county = null, limit = 100_000, ensureSchema = true } = {},
) {
  if (ensureSchema) await ensureProviderIngestionSchema(pool);
  const safeCounty = normalizedProviderCounty(county);
  const safeLimit = Math.min(1_000_000, Math.max(1, Number(limit) || 100_000));
  const { rows } = await pool.query(
    `
      WITH source AS (
        SELECT DISTINCT ON (county_key, normalized_parcel_id)
          county_key,
          normalized_parcel_id,
          account_id,
          account_id AS native_account_id,
          address_key,
          city_key,
          postal_code,
          latitude,
          longitude,
          location_source
        FROM (
          SELECT
            UPPER(REGEXP_REPLACE(BTRIM(COALESCE(account.county, '')), '\\s+COUNTY$', '', 'i')) AS county_key,
            CASE
              WHEN account.county ILIKE '%collin%' THEN REGEXP_REPLACE(
                REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '^R', '', 'i'),
                '[^0-9A-Z]', '', 'g'
              )
              ELSE REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '[^0-9A-Z]', '', 'g')
            END AS normalized_parcel_id,
            account.account_id,
            app.normalized_situs_key(account.address) AS address_key,
            REGEXP_REPLACE(UPPER(COALESCE(account.city, '')), '[^0-9A-Z]', '', 'g') AS city_key,
            account.postal_code,
            location.latitude,
            location.longitude,
            location.source AS location_source
          FROM core.accounts account
          LEFT JOIN core.account_locations location ON location.account_id = account.account_id
          WHERE ($1 = '' OR account.county ILIKE '%' || $1 || '%')
          ORDER BY account.account_id
          LIMIT $2
        ) candidates
        WHERE county_key <> '' AND normalized_parcel_id <> ''
        ORDER BY county_key, normalized_parcel_id, account_id
      ), upserted AS (
        INSERT INTO app.parcel_match_cache (
          county_key, normalized_parcel_id, account_id, native_account_id,
          address_key, city_key, postal_code, latitude, longitude,
          location_source, refreshed_at
        )
        SELECT
          county_key, normalized_parcel_id, account_id, native_account_id,
          NULLIF(address_key, ''), NULLIF(city_key, ''), postal_code,
          latitude, longitude, location_source, now()
        FROM source
        ON CONFLICT (county_key, normalized_parcel_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          native_account_id = EXCLUDED.native_account_id,
          address_key = EXCLUDED.address_key,
          city_key = EXCLUDED.city_key,
          postal_code = EXCLUDED.postal_code,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          location_source = EXCLUDED.location_source,
          refreshed_at = now()
        RETURNING account_id
      )
      SELECT COUNT(*)::integer AS refreshed FROM upserted
    `,
    [safeCounty, safeLimit],
  );
  return { county: safeCounty || "ALL", refreshed: Number(rows[0]?.refreshed || 0) };
}

export async function parcelMatchCacheStatus(pool) {
  await ensureProviderIngestionSchema(pool);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::integer AS cached_accounts,
            MAX(refreshed_at) AS latest_refresh
     FROM app.parcel_match_cache`,
  );
  return {
    cached_accounts: Number(rows[0]?.cached_accounts || 0),
    latest_refresh: rows[0]?.latest_refresh || null,
  };
}

export async function upsertProviderRawRecords(
  pool,
  { provider, resource, records, keyField = "ListingKey", ensureSchema = true },
) {
  if (ensureSchema) await ensureProviderIngestionSchema(pool);
  const safeProvider = text(provider).toLowerCase();
  const safeResource = text(resource);
  if (!safeProvider || !safeResource) throw new Error("provider_identity_required");
  const prepared = (Array.isArray(records) ? records : []).map((record) => {
    const key = text(record?.[keyField]);
    if (!key) throw new Error(`provider_record_missing_${keyField}`);
    return {
      provider_record_key: key,
      provider_modified_at: timestamp(record.ModificationTimestamp),
      payload_sha256: sha256(record),
      raw_payload: record,
    };
  });
  if (!prepared.length) return { received: 0, changed: 0, queued: 0 };
  const { rows } = await pool.query(
    `
      WITH incoming AS (
        SELECT * FROM JSONB_TO_RECORDSET($3::jsonb) AS item(
          provider_record_key text,
          provider_modified_at timestamptz,
          payload_sha256 text,
          raw_payload jsonb
        )
      ), changed AS (
        INSERT INTO app.provider_raw_records (
          provider, resource, provider_record_key, provider_modified_at,
          payload_sha256, raw_payload
        )
        SELECT $1, $2, provider_record_key, provider_modified_at,
               payload_sha256, raw_payload
        FROM incoming
        ON CONFLICT (provider, resource, provider_record_key) DO UPDATE SET
          provider_modified_at = EXCLUDED.provider_modified_at,
          payload_sha256 = EXCLUDED.payload_sha256,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = now()
        WHERE app.provider_raw_records.payload_sha256
              IS DISTINCT FROM EXCLUDED.payload_sha256
        RETURNING id
      ), queued AS (
        INSERT INTO app.provider_post_ingest_queue (
          raw_record_id, status, priority, attempts, next_attempt_at,
          leased_at, worker_id, result, last_error, updated_at
        )
        SELECT id, 'pending', 100, 0, now(), NULL, NULL, '{}'::jsonb, NULL, now()
        FROM changed
        ON CONFLICT (raw_record_id) DO UPDATE SET
          status = 'pending', priority = GREATEST(app.provider_post_ingest_queue.priority, 100),
          attempts = 0, next_attempt_at = now(), leased_at = NULL,
          worker_id = NULL, result = '{}'::jsonb, last_error = NULL, updated_at = now()
        RETURNING raw_record_id
      )
      SELECT
        (SELECT COUNT(*) FROM changed)::integer AS changed,
        (SELECT COUNT(*) FROM queued)::integer AS queued
    `,
    [safeProvider, safeResource, JSON.stringify(prepared)],
  );
  return {
    received: prepared.length,
    changed: Number(rows[0]?.changed || 0),
    queued: Number(rows[0]?.queued || 0),
  };
}

async function matchRawRecord(pool, raw) {
  const county = normalizedProviderCounty(raw.CountyOrParish || raw.County);
  const parcel = normalizedProviderParcelId(raw.ParcelNumber, county);
  const address = normalizedProviderAddress(raw.UnparsedAddress || raw.PropertyAddress);
  const city = text(raw.City || raw.PostalCity).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (parcel) {
    const { rows } = await pool.query(
      `SELECT account_id, county_key, latitude, longitude
       FROM app.parcel_match_cache
       WHERE normalized_parcel_id = $1 AND ($2 = '' OR county_key = $2)
       ORDER BY (county_key = $2) DESC, account_id
       LIMIT 2`,
      [parcel, county],
    );
    if (rows.length === 1) return { ...rows[0], method: "parcel_cache" };
  }
  if (address) {
    const { rows } = await pool.query(
      `SELECT account_id, county_key, latitude, longitude
       FROM app.parcel_match_cache
       WHERE address_key = $1
         AND ($2 = '' OR city_key = $2)
         AND ($3 = '' OR county_key = $3)
       ORDER BY account_id
       LIMIT 2`,
      [address, city, county],
    );
    if (rows.length === 1) return { ...rows[0], method: "exact_address_cache" };
  }
  return null;
}

async function storeTrestleObservations(pool, accountId, county, raw) {
  const mapped = mapTrestleProperty(raw);
  const excluded = new Set([
    "listing_key", "listing_id", "parcel_number", "address", "city", "county",
    "postal_code", "latitude", "longitude", "modification_timestamp",
  ]);
  const values = Object.entries(mapped).filter(
    ([key, value]) => !excluded.has(key) && value !== null && value !== undefined && value !== "",
  );
  if (!values.length) return 0;
  await pool.query(
    `INSERT INTO app.property_attribute_observations (
       account_id, county, attribute_key, attribute_value, source_type,
       source_reference, source_observed_at, confidence, raw_payload
     )
     SELECT $1, $2, item.attribute_key, item.attribute_value, 'trestle',
            $3, $4, 1.000, $5::jsonb
     FROM JSONB_TO_RECORDSET($6::jsonb) AS item(
       attribute_key text,
       attribute_value jsonb
     )`,
    [
      accountId,
      county || "UNKNOWN",
      text(raw.ListingKey || raw.ListingId),
      timestamp(raw.ModificationTimestamp),
      JSON.stringify({
        ListingKey: raw.ListingKey || null,
        ListingId: raw.ListingId || null,
        OriginatingSystemName: raw.OriginatingSystemName || null,
      }),
      JSON.stringify(values.map(([attribute_key, value]) => ({
        attribute_key,
        attribute_value: value,
      }))),
    ],
  );
  return values.length;
}

async function storeProviderCoordinates(pool, accountId, raw) {
  const latitude = coordinate(raw.Latitude, "latitude");
  const longitude = coordinate(raw.Longitude, "longitude");
  if (latitude === null || longitude === null) return false;
  await pool.query(
    `INSERT INTO core.account_locations (
       account_id, latitude, longitude, status, source, precision,
       confidence, match_method, source_parcel_id, source_site_address,
       source_updated_at, feature_count, review_required, metadata, updated_at
     ) VALUES (
       $1,$2,$3,'matched','trestle','listing_coordinate','medium',
       'provider_parcel_or_address',$4,$5,$6,1,false,$7::jsonb,now()
     )
     ON CONFLICT (account_id) DO UPDATE SET
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       status = 'matched', source = EXCLUDED.source,
       precision = EXCLUDED.precision, confidence = EXCLUDED.confidence,
       match_method = EXCLUDED.match_method,
       source_parcel_id = EXCLUDED.source_parcel_id,
       source_site_address = EXCLUDED.source_site_address,
       source_updated_at = EXCLUDED.source_updated_at,
       review_required = false, review_reason = NULL,
       metadata = EXCLUDED.metadata, updated_at = now()
     WHERE core.account_locations.source <> 'dcad_parcel_query'
        OR core.account_locations.status <> 'matched'
        OR core.account_locations.latitude IS NULL
        OR core.account_locations.longitude IS NULL`,
    [
      accountId,
      latitude,
      longitude,
      text(raw.ParcelNumber) || null,
      text(raw.UnparsedAddress) || null,
      timestamp(raw.ModificationTimestamp),
      JSON.stringify({ provider: "trestle", listing_key: raw.ListingKey || null }),
    ],
  );
  return true;
}

/**
 * Resolve provider rows against existing CAD accounts and immediately store
 * coordinates/observations. It deliberately never creates a canonical CAD
 * account from MLS data; unmatched rows remain available for manual review.
 */
export async function runProviderPostIngestBatch(
  pool,
  {
    provider = "trestle",
    batchSize = 100,
    workerId = randomUUID(),
    ensureSchema = true,
  } = {},
) {
  if (ensureSchema) await ensureProviderIngestionSchema(pool);
  const safeBatchSize = Math.min(500, Math.max(1, Number(batchSize) || 100));
  await pool.query(
    `UPDATE app.provider_post_ingest_queue
     SET status = 'retry', worker_id = NULL, leased_at = NULL,
         next_attempt_at = now(), last_error = COALESCE(last_error, 'stale_worker_lease'),
         updated_at = now()
     WHERE status = 'processing'
       AND leased_at < now() - interval '15 minutes'`,
  );
  const { rows } = await pool.query(
    `WITH next_items AS (
       SELECT queue.raw_record_id
       FROM app.provider_post_ingest_queue queue
       JOIN app.provider_raw_records raw ON raw.id = queue.raw_record_id
       WHERE queue.status IN ('pending','retry')
         AND queue.next_attempt_at <= now()
         AND raw.provider = $1
       ORDER BY queue.priority DESC, queue.next_attempt_at, queue.raw_record_id
       LIMIT $2
       FOR UPDATE OF queue SKIP LOCKED
     )
     UPDATE app.provider_post_ingest_queue queue
     SET status = 'processing', worker_id = $3, leased_at = now(), updated_at = now()
     FROM next_items, app.provider_raw_records raw
     WHERE queue.raw_record_id = next_items.raw_record_id
       AND raw.id = queue.raw_record_id
     RETURNING queue.raw_record_id, raw.raw_payload, raw.provider_record_key`,
    [text(provider).toLowerCase(), safeBatchSize, workerId],
  );
  const totals = { claimed: rows.length, completed: 0, manualReview: 0, retry: 0 };
  for (const item of rows) {
    try {
      const raw = item.raw_payload || {};
      const match = await matchRawRecord(pool, raw);
      if (!match) {
        await pool.query(
          `UPDATE app.provider_post_ingest_queue
           SET status = 'manual_review', attempts = attempts + 1,
               result = $3::jsonb, last_error = 'canonical_cad_account_not_matched',
               worker_id = NULL, leased_at = NULL, updated_at = now()
           WHERE raw_record_id = $1 AND worker_id = $2`,
          [item.raw_record_id, workerId, JSON.stringify({
            listing_key: item.provider_record_key,
            parcel_number: raw.ParcelNumber || null,
            address: raw.UnparsedAddress || null,
          })],
        );
        totals.manualReview += 1;
        continue;
      }
      const coordinatesStored = await storeProviderCoordinates(pool, match.account_id, raw);
      const observationCount = await storeTrestleObservations(
        pool,
        match.account_id,
        match.county_key,
        raw,
      );
      if (!coordinatesStored) {
        await enqueueLocationBackfillAccounts(
          pool,
          [{
            account_id: match.account_id,
            address: raw.UnparsedAddress || null,
            county: match.county_key,
          }],
          { reason: "trestle_ingest", priority: 100 },
        );
      }
      const result = {
        account_id: match.account_id,
        account_match_method: match.method,
        coordinates_stored: coordinatesStored,
        observations_stored: observationCount,
        // MUST-DO before enabling the production feed: map Property status,
        // price/date fields and related Media into core.sales_source_records,
        // core.sales, and core.sales_source_media in one idempotent transaction.
        canonical_sales_mapping: "pending_feed_contract_validation",
      };
      await pool.query(
        `UPDATE app.provider_raw_records
         SET canonical_account_id = $2, account_match_method = $3,
             account_matched_at = now(), updated_at = now()
         WHERE id = $1`,
        [item.raw_record_id, match.account_id, match.method],
      );
      await pool.query(
        `UPDATE app.provider_post_ingest_queue
         SET status = 'completed', result = $3::jsonb, last_error = NULL,
             worker_id = NULL, leased_at = NULL, updated_at = now()
         WHERE raw_record_id = $1 AND worker_id = $2`,
        [item.raw_record_id, workerId, JSON.stringify(result)],
      );
      totals.completed += 1;
    } catch (error) {
      await pool.query(
        `UPDATE app.provider_post_ingest_queue
         SET status = CASE WHEN attempts + 1 >= 5 THEN 'manual_review' ELSE 'retry' END,
             attempts = attempts + 1,
             next_attempt_at = now() + interval '5 minutes',
             last_error = $3, worker_id = NULL, leased_at = NULL, updated_at = now()
         WHERE raw_record_id = $1 AND worker_id = $2`,
        [item.raw_record_id, workerId, text(error?.message || error).slice(0, 1000)],
      );
      totals.retry += 1;
    }
  }
  return totals;
}
