import { createHash, randomUUID } from "node:crypto";

import { ensureAccountLocationsTable } from "./accountLocations.js";
import { ensureLocationBackfillQueueSchema } from "./locationBackfillQueue.js";
import { ensurePropertyContextSchema } from "./propertyContextStore.js";
import { ensurePropertyEnrichmentSchema } from "./propertyEnrichment.js";
import { mapTrestleProperty } from "./trestleClient.js";

const TRESTLE_REPLICATION_LOCK_A = 48_632_941;
const TRESTLE_REPLICATION_LOCK_B = 20_260_819;
const TRESTLE_SOURCE_FILENAME = "trestle://Property";

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function firstValue(...values) {
  return values.find(hasValue) ?? null;
}

function text(value, maximumLength = 8_000) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function numberValue(value) {
  if (!hasValue(value)) return null;
  const parsed = Number(String(value).replace(/[$,%]/g, "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value) {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return null;
}

function isoDate(value) {
  if (!hasValue(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString().slice(0, 10) : null;
}

function isoTimestamp(value) {
  if (!hasValue(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizedParcelKey(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function normalizedPlace(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+COUNTY$/, "")
    .replace(/[^0-9A-Z]/g, "");
}

function normalizedAddress(value) {
  return String(value ?? "")
    .split(",")[0]
    .trim()
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
    .replace(/\bPLACE\b/g, "PL")
    .replace(/\bTRAIL\b/g, "TRL")
    .replace(/[^0-9A-Z]/g, "");
}

function propertyAddress(record) {
  const supplied = firstValue(
    record.UnparsedAddress,
    record.PropertyAddress,
    record.StreetAddress,
  );
  if (supplied) return text(supplied, 500);
  const line = [
    record.StreetNumber,
    record.StreetDirPrefix,
    record.StreetName,
    record.StreetSuffix,
    record.StreetDirSuffix,
    record.UnitNumber ? `#${record.UnitNumber}` : null,
  ].filter(hasValue).join(" ");
  return text(line, 500);
}

function normalizedAttachmentType(record) {
  const attached = booleanValue(record.PropertyAttachedYN);
  if (attached === true) return "attached";
  if (attached === false) return "detached";
  const description = [record.PropertySubType, record.StructureType]
    .filter(hasValue)
    .join(" ")
    .toLowerCase();
  const saysAttached = /attached|townhome|townhouse|condo|duplex/.test(description);
  const saysDetached = /detached|single[- ]?family|single detached/.test(description);
  if (saysAttached && saysDetached) return "mixed";
  if (saysAttached) return "attached";
  if (saysDetached) return "detached";
  return "unknown";
}

function recordType(status) {
  return String(status || "").trim().toLowerCase() === "closed"
    ? "closed_sale"
    : "listing";
}

function ratio(numerator, denominator) {
  const a = numberValue(numerator);
  const b = numberValue(denominator);
  return a !== null && b > 0 ? a / b : null;
}

export function mapTrestleSourceRecord(record = {}) {
  const listingKey = text(record.ListingKey, 255);
  if (!listingKey) throw new Error("trestle_listing_key_missing");
  const status = text(record.StandardStatus || record.MlsStatus, 100);
  const type = recordType(status);
  const closePrice = numberValue(record.ClosePrice);
  const listPrice = numberValue(firstValue(record.ListPrice, record.OriginalListPrice));
  const livingArea = numberValue(firstValue(record.LivingArea, record.AboveGradeFinishedArea));
  const lotSizeArea = numberValue(record.LotSizeSquareFeet)
    ?? (numberValue(record.LotSizeAcres) === null
      ? null
      : numberValue(record.LotSizeAcres) * 43_560);
  const currentPrice = type === "closed_sale"
    ? (closePrice ?? listPrice)
    : (listPrice ?? closePrice);
  const parcelNumber = text(record.ParcelNumber, 200);
  const address = propertyAddress(record);
  const city = text(record.City, 150);
  const county = text(record.CountyOrParish, 150);
  const attachmentType = normalizedAttachmentType(record);
  const flags = [];
  if (!parcelNumber) flags.push("missing_parcel_number");
  if (!address) flags.push("missing_property_address");
  if (!isoTimestamp(record.ModificationTimestamp)) flags.push("missing_modification_timestamp");
  if (attachmentType === "mixed") flags.push("mixed_attachment_classification");
  if (type === "closed_sale" && (!isoDate(record.CloseDate) || !(closePrice > 0))) {
    flags.push("incomplete_closed_sale");
  }
  const stableHash = sha256(`trestle-property:${listingKey}`);
  return {
    listing_key: listingKey,
    listing_id: text(record.ListingId, 255),
    originating_system_name: text(record.OriginatingSystemName, 255),
    source_modified_at: isoTimestamp(record.ModificationTimestamp),
    photos_change_timestamp: isoTimestamp(record.PhotosChangeTimestamp),
    photos_count: Math.max(0, integerValue(record.PhotosCount) || 0),
    source_name: text(
      record.OriginatingSystemName
        ? `Trestle RESO - ${record.OriginatingSystemName}`
        : "Trestle RESO Web API",
      255,
    ),
    source_filename: TRESTLE_SOURCE_FILENAME,
    source_files: [TRESTLE_SOURCE_FILENAME],
    source_sha256: stableHash,
    source_row_number: 1,
    source_record_hash: stableHash,
    transaction_fingerprint: sha256(`trestle-transaction:${listingKey}`),
    bedrooms_total: integerValue(record.BedroomsTotal),
    bathrooms_total_integer: integerValue(record.BathroomsTotalInteger),
    bathrooms_full: integerValue(record.BathroomsFull),
    bathrooms_half: integerValue(record.BathroomsHalf),
    living_area: livingArea,
    lot_size_area: lotSizeArea,
    current_price: currentPrice,
    ratio_current_price_by_living_area: ratio(currentPrice, livingArea),
    ratio_close_price_by_list_price: ratio(closePrice, record.ListPrice),
    ratio_close_price_by_original_list_price: ratio(closePrice, record.OriginalListPrice),
    ratio_close_price_by_living_area: ratio(closePrice, livingArea),
    days_on_market: integerValue(record.DaysOnMarket),
    year_built: integerValue(record.YearBuilt),
    close_date: isoDate(record.CloseDate),
    seller_contributions: numberValue(firstValue(
      record.ConcessionsAmount,
      record.SellerConcessions,
    )),
    mls_status: status,
    garage_spaces: numberValue(record.GarageSpaces),
    garage_yn: booleanValue(record.GarageYN)
      ?? (numberValue(record.GarageSpaces) === null ? null : numberValue(record.GarageSpaces) > 0),
    pool_yn: booleanValue(record.PoolPrivateYN),
    listing_contract_date: isoDate(record.ListingContractDate),
    parcel_number_raw: parcelNumber,
    parcel_number2_raw: text(record.AdditionalParcelsDescription, 500),
    buyer_financing: text(record.BuyerFinancing, 500),
    record_type: type,
    structural_style: text(firstValue(record.PropertySubType, record.StructureType), 500),
    housing_type: text(firstValue(record.PropertySubType, record.StructureType), 500),
    attachment_type: attachmentType,
    architectural_style: text(record.ArchitecturalStyle, 500),
    address,
    address_key: normalizedAddress(address),
    city,
    city_key: normalizedPlace(city),
    state: text(record.StateOrProvince, 50) || "TX",
    postal_code: text(record.PostalCode, 30),
    county,
    county_key: normalizedPlace(county),
    parcel_key: normalizedPlace(county) === "COLLIN"
      ? normalizedParcelKey(parcelNumber).replace(/^R/, "")
      : normalizedParcelKey(parcelNumber),
    latitude: numberValue(record.Latitude),
    longitude: numberValue(record.Longitude),
    data_quality_flags: flags,
    property_attributes: mapTrestleProperty(record),
    raw_payload: record,
  };
}

export async function ensureTrestleReplicationSchema(pool) {
  await ensureAccountLocationsTable(pool);
  await ensureLocationBackfillQueueSchema(pool);
  await ensurePropertyContextSchema(pool);
  await ensurePropertyEnrichmentSchema(pool);
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    ALTER TABLE core.sales_source_records
      ADD COLUMN IF NOT EXISTS source_modified_at timestamptz,
      ADD COLUMN IF NOT EXISTS source_system_name text;

    DROP INDEX IF EXISTS core.sales_source_records_listing_id_unique_idx;
    CREATE INDEX IF NOT EXISTS sales_source_records_listing_id_idx
      ON core.sales_source_records (listing_id)
      WHERE NULLIF(BTRIM(listing_id), '') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS sales_source_records_listing_key_unique_idx
      ON core.sales_source_records (listing_key)
      WHERE NULLIF(BTRIM(listing_key), '') IS NOT NULL;

    CREATE TABLE IF NOT EXISTS app.trestle_replication_runs (
      id                    bigserial PRIMARY KEY,
      worker_id             text NOT NULL,
      resource_name         text NOT NULL DEFAULT 'Property',
      status                text NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running','completed','partial','failed','skipped')),
      cursor_started_at     timestamptz,
      cursor_completed_at   timestamptz,
      page_count            integer NOT NULL DEFAULT 0,
      records_received      integer NOT NULL DEFAULT 0,
      records_upserted      integer NOT NULL DEFAULT 0,
      records_rejected      integer NOT NULL DEFAULT 0,
      matched_count         integer NOT NULL DEFAULT 0,
      unmatched_count       integer NOT NULL DEFAULT 0,
      media_queued_count    integer NOT NULL DEFAULT 0,
      started_at            timestamptz NOT NULL DEFAULT now(),
      completed_at          timestamptz,
      error_message         text,
      details               jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS trestle_replication_runs_started_idx
      ON app.trestle_replication_runs (started_at DESC);

    CREATE TABLE IF NOT EXISTS app.trestle_replication_state (
      resource_name         text PRIMARY KEY,
      cursor_timestamp      timestamptz,
      cursor_listing_key    text,
      status                text NOT NULL DEFAULT 'idle'
                              CHECK (status IN ('idle','running','partial','failed')),
      last_run_id           bigint REFERENCES app.trestle_replication_runs(id),
      last_started_at       timestamptz,
      last_completed_at     timestamptz,
      last_success_at       timestamptz,
      last_error            text,
      last_quota            jsonb,
      updated_at            timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app.trestle_media_queue (
      listing_key            text PRIMARY KEY,
      source_record_id       bigint NOT NULL
                               REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
      photos_change_timestamp timestamptz,
      expected_photo_count   integer NOT NULL DEFAULT 0,
      status                 text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','processing','completed','retry','manual_review')),
      attempts               integer NOT NULL DEFAULT 0,
      available_at           timestamptz NOT NULL DEFAULT now(),
      locked_at              timestamptz,
      locked_by              text,
      completed_at           timestamptz,
      last_error             text,
      updated_at             timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS trestle_media_queue_status_idx
      ON app.trestle_media_queue (status, available_at, updated_at);
  `);
}

export async function resolveTrestleAccountMatches(pool, records) {
  const requested = records.map((record) => ({
    listing_key: record.listing_key,
    parcel_raw: record.parcel_number_raw,
    parcel_key: record.parcel_key || null,
    address_key: record.address_key || null,
    city_key: record.city_key || null,
    county_key: record.county_key || null,
  }));
  if (!requested.length) return new Map();
  const { rows } = await pool.query(
    `WITH requested AS (
       SELECT *
       FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
         listing_key text, parcel_raw text, parcel_key text,
         address_key text, city_key text, county_key text
       )
     ), parcel_candidates AS (
       SELECT request.listing_key, account.account_id,
              CASE WHEN BTRIM(account.account_id) = BTRIM(request.parcel_raw)
                THEN 'exact' ELSE 'normalized' END AS match_status
       FROM requested request
       JOIN core.accounts account
         ON request.parcel_key IS NOT NULL
        AND request.parcel_key <> ''
        AND CASE WHEN request.county_key = 'COLLIN'
              THEN REGEXP_REPLACE(
                REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '[^0-9A-Z]', '', 'g'),
                '^R', ''
              )
              ELSE REGEXP_REPLACE(UPPER(BTRIM(account.account_id)), '[^0-9A-Z]', '', 'g')
            END = request.parcel_key
        AND (
          request.county_key IS NULL OR request.county_key = ''
          OR REGEXP_REPLACE(
               UPPER(REGEXP_REPLACE(BTRIM(COALESCE(account.county, '')), '\\s+COUNTY$', '', 'i')),
               '[^0-9A-Z]', '', 'g'
             ) = request.county_key
        )
     ), parcel_unique AS (
       SELECT listing_key, MIN(account_id) AS account_id,
              MIN(match_status) AS match_status
       FROM parcel_candidates
       GROUP BY listing_key HAVING COUNT(DISTINCT account_id) = 1
     ), address_candidates AS (
       SELECT request.listing_key, account.account_id
       FROM requested request
       JOIN core.accounts account
         ON request.address_key IS NOT NULL AND request.address_key <> ''
        AND request.city_key IS NOT NULL AND request.city_key <> ''
        AND REGEXP_REPLACE(UPPER(BTRIM(COALESCE(account.address, ''))), '[^0-9A-Z]', '', 'g') = request.address_key
        AND REGEXP_REPLACE(UPPER(BTRIM(COALESCE(account.city, ''))), '[^0-9A-Z]', '', 'g') = request.city_key
        AND (
          request.county_key IS NULL OR request.county_key = ''
          OR REGEXP_REPLACE(
               UPPER(REGEXP_REPLACE(BTRIM(COALESCE(account.county, '')), '\\s+COUNTY$', '', 'i')),
               '[^0-9A-Z]', '', 'g'
             ) = request.county_key
        )
     ), address_unique AS (
       SELECT listing_key, MIN(account_id) AS account_id
       FROM address_candidates
       GROUP BY listing_key HAVING COUNT(DISTINCT account_id) = 1
     )
     SELECT request.listing_key,
            COALESCE(parcel.account_id, address.account_id) AS account_id,
            CASE WHEN parcel.account_id IS NOT NULL THEN parcel.match_status
                 WHEN address.account_id IS NOT NULL THEN 'secondary'
                 ELSE 'unmatched' END AS match_status
     FROM requested request
     LEFT JOIN parcel_unique parcel USING (listing_key)
     LEFT JOIN address_unique address USING (listing_key)`,
    [JSON.stringify(requested)],
  );
  return new Map(rows.map((row) => [row.listing_key, {
    account_id: row.account_id || null,
    match_status: row.match_status || "unmatched",
  }]));
}

function persistenceRecord(record, match) {
  const matched = Boolean(match?.account_id);
  const flags = [...record.data_quality_flags];
  if (!matched) flags.push("unmatched_cad_account");
  return {
    ...record,
    primary_account_id: match?.account_id || null,
    match_status: match?.match_status || "unmatched",
    has_unresolved_parcel: !matched && Boolean(record.parcel_number_raw),
    requires_additional_review: !matched || flags.length > 0,
    data_quality_flags: [...new Set(flags)],
  };
}

async function upsertTrestleSourceRecords(client, records) {
  if (!records.length) return [];
  const { rows } = await client.query(
    `WITH input AS (
       SELECT * FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
         listing_key text, listing_id text, originating_system_name text,
         source_modified_at timestamptz, photos_change_timestamp timestamptz,
         photos_count integer, source_name text, source_filename text,
         source_files text[], source_sha256 text, source_row_number integer,
         source_record_hash text, transaction_fingerprint text,
         bedrooms_total integer, bathrooms_total_integer integer,
         bathrooms_full integer, bathrooms_half integer, living_area numeric,
         lot_size_area numeric, current_price numeric,
         ratio_current_price_by_living_area numeric,
         ratio_close_price_by_list_price numeric,
         ratio_close_price_by_original_list_price numeric,
         ratio_close_price_by_living_area numeric, days_on_market integer,
         year_built integer, close_date date, seller_contributions numeric,
         mls_status text, garage_spaces numeric, garage_yn boolean, pool_yn boolean,
         listing_contract_date date, parcel_number_raw text,
         parcel_number2_raw text, buyer_financing text, record_type text,
         structural_style text, housing_type text, attachment_type text,
         architectural_style text, address text, city text, state text,
         postal_code text, county text, latitude double precision,
         longitude double precision, primary_account_id text, match_status text,
         has_unresolved_parcel boolean, requires_additional_review boolean,
         data_quality_flags jsonb, raw_payload jsonb
       )
     ), upserted AS (
       INSERT INTO core.sales_source_records (
         source_name, source_filename, source_files, source_sha256,
         source_row_number, source_record_hash, transaction_fingerprint,
         bedrooms_total, bathrooms_total_integer, bathrooms_full, bathrooms_half,
         living_area, lot_size_area, current_price,
         ratio_current_price_by_living_area, ratio_close_price_by_list_price,
         ratio_close_price_by_original_list_price, ratio_close_price_by_living_area,
         days_on_market, year_built, close_date, seller_contributions, mls_status,
         garage_spaces, garage_yn, pool_yn, listing_contract_date,
         parcel_number_raw, parcel_number2_raw, buyer_financing, record_type,
         structural_style, housing_type, attachment_type, architectural_style,
         listing_key, listing_id, primary_account_id, match_status,
         has_multiple_parcel_numbers, multi_parcel_status, has_unresolved_parcel,
         requires_additional_review, data_quality_flags, raw_payload,
         source_modified_at, source_system_name
       )
       SELECT
         source_name, source_filename, source_files, source_sha256,
         source_row_number, source_record_hash, transaction_fingerprint,
         bedrooms_total, bathrooms_total_integer, bathrooms_full, bathrooms_half,
         living_area, lot_size_area, current_price,
         ratio_current_price_by_living_area, ratio_close_price_by_list_price,
         ratio_close_price_by_original_list_price, ratio_close_price_by_living_area,
         days_on_market, year_built, close_date, seller_contributions, mls_status,
         garage_spaces, garage_yn, pool_yn, listing_contract_date,
         parcel_number_raw, parcel_number2_raw, buyer_financing, record_type,
         structural_style, housing_type, attachment_type, architectural_style,
         listing_key, listing_id, primary_account_id, match_status,
         parcel_number2_raw IS NOT NULL, CASE WHEN parcel_number2_raw IS NULL THEN 'single' ELSE 'possible' END,
         has_unresolved_parcel, requires_additional_review, data_quality_flags,
         raw_payload, source_modified_at, originating_system_name
       FROM input
       ON CONFLICT (listing_key)
         WHERE listing_key IS NOT NULL AND BTRIM(listing_key) <> ''
       DO UPDATE SET
         source_name = EXCLUDED.source_name,
         source_files = CASE
           WHEN core.sales_source_records.source_files @> EXCLUDED.source_files
             THEN core.sales_source_records.source_files
           ELSE core.sales_source_records.source_files || EXCLUDED.source_files
         END,
         bedrooms_total = COALESCE(EXCLUDED.bedrooms_total, core.sales_source_records.bedrooms_total),
         bathrooms_total_integer = COALESCE(EXCLUDED.bathrooms_total_integer, core.sales_source_records.bathrooms_total_integer),
         bathrooms_full = COALESCE(EXCLUDED.bathrooms_full, core.sales_source_records.bathrooms_full),
         bathrooms_half = COALESCE(EXCLUDED.bathrooms_half, core.sales_source_records.bathrooms_half),
         living_area = COALESCE(EXCLUDED.living_area, core.sales_source_records.living_area),
         lot_size_area = COALESCE(EXCLUDED.lot_size_area, core.sales_source_records.lot_size_area),
         current_price = COALESCE(EXCLUDED.current_price, core.sales_source_records.current_price),
         ratio_current_price_by_living_area = COALESCE(EXCLUDED.ratio_current_price_by_living_area, core.sales_source_records.ratio_current_price_by_living_area),
         ratio_close_price_by_list_price = COALESCE(EXCLUDED.ratio_close_price_by_list_price, core.sales_source_records.ratio_close_price_by_list_price),
         ratio_close_price_by_original_list_price = COALESCE(EXCLUDED.ratio_close_price_by_original_list_price, core.sales_source_records.ratio_close_price_by_original_list_price),
         ratio_close_price_by_living_area = COALESCE(EXCLUDED.ratio_close_price_by_living_area, core.sales_source_records.ratio_close_price_by_living_area),
         days_on_market = COALESCE(EXCLUDED.days_on_market, core.sales_source_records.days_on_market),
         year_built = COALESCE(EXCLUDED.year_built, core.sales_source_records.year_built),
         close_date = COALESCE(EXCLUDED.close_date, core.sales_source_records.close_date),
         seller_contributions = COALESCE(EXCLUDED.seller_contributions, core.sales_source_records.seller_contributions),
         mls_status = COALESCE(EXCLUDED.mls_status, core.sales_source_records.mls_status),
         garage_spaces = COALESCE(EXCLUDED.garage_spaces, core.sales_source_records.garage_spaces),
         garage_yn = COALESCE(EXCLUDED.garage_yn, core.sales_source_records.garage_yn),
         pool_yn = COALESCE(EXCLUDED.pool_yn, core.sales_source_records.pool_yn),
         listing_contract_date = COALESCE(EXCLUDED.listing_contract_date, core.sales_source_records.listing_contract_date),
         parcel_number_raw = COALESCE(EXCLUDED.parcel_number_raw, core.sales_source_records.parcel_number_raw),
         parcel_number2_raw = COALESCE(EXCLUDED.parcel_number2_raw, core.sales_source_records.parcel_number2_raw),
         buyer_financing = COALESCE(EXCLUDED.buyer_financing, core.sales_source_records.buyer_financing),
         record_type = EXCLUDED.record_type,
         structural_style = COALESCE(EXCLUDED.structural_style, core.sales_source_records.structural_style),
         housing_type = COALESCE(EXCLUDED.housing_type, core.sales_source_records.housing_type),
         attachment_type = CASE WHEN EXCLUDED.attachment_type = 'unknown'
           THEN core.sales_source_records.attachment_type ELSE EXCLUDED.attachment_type END,
         architectural_style = COALESCE(EXCLUDED.architectural_style, core.sales_source_records.architectural_style),
         listing_id = COALESCE(EXCLUDED.listing_id, core.sales_source_records.listing_id),
         primary_account_id = CASE WHEN core.sales_source_records.match_status = 'manual_verified'
           THEN core.sales_source_records.primary_account_id ELSE EXCLUDED.primary_account_id END,
         match_status = CASE WHEN core.sales_source_records.match_status = 'manual_verified'
           THEN core.sales_source_records.match_status ELSE EXCLUDED.match_status END,
         has_multiple_parcel_numbers = EXCLUDED.has_multiple_parcel_numbers,
         multi_parcel_status = EXCLUDED.multi_parcel_status,
         has_unresolved_parcel = CASE WHEN core.sales_source_records.match_status = 'manual_verified'
           THEN core.sales_source_records.has_unresolved_parcel ELSE EXCLUDED.has_unresolved_parcel END,
         requires_additional_review = CASE WHEN core.sales_source_records.match_status = 'manual_verified'
           THEN core.sales_source_records.requires_additional_review ELSE EXCLUDED.requires_additional_review END,
         data_quality_flags = CASE WHEN core.sales_source_records.match_status = 'manual_verified'
           THEN core.sales_source_records.data_quality_flags ELSE EXCLUDED.data_quality_flags END,
         raw_payload = EXCLUDED.raw_payload,
         source_modified_at = COALESCE(
           EXCLUDED.source_modified_at,
           core.sales_source_records.source_modified_at
         ),
         source_system_name = COALESCE(EXCLUDED.source_system_name, core.sales_source_records.source_system_name),
         updated_at = now()
       WHERE core.sales_source_records.source_modified_at IS NULL
          OR EXCLUDED.source_modified_at IS NULL
          OR EXCLUDED.source_modified_at >= core.sales_source_records.source_modified_at
       RETURNING id, listing_key, primary_account_id, match_status, record_type,
                 close_date, current_price, days_on_market, seller_contributions
     )
     SELECT upserted.*, input.address, input.city, input.state, input.postal_code,
            input.county, input.latitude, input.longitude, input.parcel_number_raw,
            input.photos_change_timestamp, input.photos_count
     FROM upserted JOIN input USING (listing_key)`,
    [JSON.stringify(records)],
  );
  return rows;
}

async function rebuildParcelLinks(client, persisted) {
  const replaceable = persisted.filter((row) => row.match_status !== "manual_verified");
  if (!replaceable.length) return;
  await client.query(
    `DELETE FROM core.sale_parcels parcel
     USING JSONB_TO_RECORDSET($1::jsonb) AS item(source_record_id bigint)
     WHERE parcel.source_record_id = item.source_record_id`,
    [JSON.stringify(replaceable.map((row) => ({ source_record_id: row.id })))],
  );
  const links = replaceable
    .filter((row) => row.parcel_number_raw)
    .map((row) => ({
      source_record_id: row.id,
      parcel_number_raw: row.parcel_number_raw,
      account_id: row.primary_account_id,
      match_method: row.primary_account_id
        ? (row.match_status === "exact" ? "exact" : "punctuation_normalized")
        : "unmatched",
      is_resolved: Boolean(row.primary_account_id),
    }));
  if (!links.length) return;
  await client.query(
    `INSERT INTO core.sale_parcels (
       source_record_id, source_position, parcel_sequence, parcel_role,
       parcel_number_raw, parcel_number_normalized, account_id,
       match_method, is_resolved
     )
     SELECT source_record_id, 1, 1, 'primary', parcel_number_raw,
            CASE WHEN is_resolved THEN account_id ELSE NULL END,
            account_id, match_method, is_resolved
     FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
       source_record_id bigint, parcel_number_raw text, account_id text,
       match_method text, is_resolved boolean
     )`,
    [JSON.stringify(links)],
  );
}

async function upsertCanonicalSales(client, persisted) {
  const eligible = persisted.filter((row) => (
    row.primary_account_id &&
    row.record_type === "closed_sale" &&
    row.close_date &&
    Number(row.current_price) > 0
  ));
  if (!eligible.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO core.sales (
       account_id, address, city, state, zip, closing_date, sale_price,
       days_on_market, concessions, source, source_record_id
     )
     SELECT primary_account_id, address, city, COALESCE(state, 'TX'), postal_code,
            close_date, current_price, days_on_market,
            CASE WHEN seller_contributions IS NULL THEN NULL
                 ELSE seller_contributions::text END,
            'Trestle RESO Web API', id
     FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
       id bigint, primary_account_id text, address text, city text, state text,
       postal_code text, close_date date, current_price numeric,
       days_on_market integer, seller_contributions numeric
     )
     ON CONFLICT (source_record_id) WHERE source_record_id IS NOT NULL
     DO UPDATE SET
       account_id = EXCLUDED.account_id,
       address = COALESCE(EXCLUDED.address, core.sales.address),
       city = COALESCE(EXCLUDED.city, core.sales.city),
       state = COALESCE(EXCLUDED.state, core.sales.state),
       zip = COALESCE(EXCLUDED.zip, core.sales.zip),
       closing_date = EXCLUDED.closing_date,
       sale_price = EXCLUDED.sale_price,
       days_on_market = EXCLUDED.days_on_market,
       concessions = EXCLUDED.concessions,
       source = EXCLUDED.source,
       loaded_at = now()`,
    [JSON.stringify(eligible)],
  );
  return rowCount || eligible.length;
}

async function cacheTrestleCoordinates(client, persisted) {
  const eligible = persisted.filter((row) => (
    row.primary_account_id &&
    row.latitude >= 25.5 && row.latitude <= 36.6 &&
    row.longitude >= -106.7 && row.longitude <= -93.4 &&
    normalizedPlace(row.county) !== "DALLAS"
  ));
  if (!eligible.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO core.account_locations (
       account_id, latitude, longitude, status, source, precision, confidence,
       match_method, source_parcel_id, source_site_address, source_updated_at,
       feature_count, review_required, metadata, geocoded_at, updated_at
     )
     SELECT primary_account_id, latitude, longitude, 'matched', 'trestle_reso',
            'listing_point', 'high', match_status, parcel_number_raw, address,
            source_modified_at, 1, false,
            jsonb_build_object('listing_key', listing_key), now(), now()
     FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
       primary_account_id text, latitude double precision, longitude double precision,
       match_status text, parcel_number_raw text, address text,
       source_modified_at timestamptz, listing_key text
     )
     ON CONFLICT (account_id) DO NOTHING`,
    [JSON.stringify(eligible)],
  );
  return rowCount || 0;
}

async function storeTrestlePropertyObservations(client, persisted, preparedByListingKey) {
  const observations = [];
  for (const row of persisted) {
    const prepared = preparedByListingKey.get(row.listing_key);
    if (!row.primary_account_id || !prepared || normalizedPlace(prepared.county) === "DALLAS") {
      continue;
    }
    for (const [attributeKey, attributeValue] of Object.entries(
      prepared.property_attributes || {},
    )) {
      if (!hasValue(attributeValue)) continue;
      observations.push({
        account_id: row.primary_account_id,
        county: prepared.county || "Unknown",
        attribute_key: attributeKey,
        attribute_value: attributeValue,
        source_reference: prepared.listing_key,
        source_observed_at: prepared.source_modified_at,
        raw_payload: {
          ListingKey: prepared.listing_key,
          ListingId: prepared.listing_id,
          OriginatingSystemName: prepared.originating_system_name,
        },
      });
    }
  }
  if (!observations.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO app.property_attribute_observations (
       account_id, county, attribute_key, attribute_value, source_type,
       source_reference, source_observed_at, confidence, raw_payload
     )
     SELECT account_id, county, attribute_key, attribute_value, 'trestle',
            source_reference, source_observed_at, 1.000, raw_payload
     FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
       account_id text, county text, attribute_key text, attribute_value jsonb,
       source_reference text, source_observed_at timestamptz, raw_payload jsonb
     )
     WHERE NOT EXISTS (
       SELECT 1 FROM app.property_attribute_observations existing
       WHERE existing.account_id = item.account_id
         AND existing.attribute_key = item.attribute_key
         AND existing.source_type = 'trestle'
         AND existing.source_reference = item.source_reference
         AND existing.source_observed_at IS NOT DISTINCT FROM item.source_observed_at
     )`,
    [JSON.stringify(observations)],
  );
  return rowCount || observations.length;
}

async function queueTrestleMedia(client, persisted) {
  // A zero count with a newer PhotosChangeTimestamp is meaningful: it removes
  // photos that disappeared upstream instead of leaving stale MLS imagery.
  const eligible = persisted.filter((row) => (
    Number(row.photos_count) > 0 || row.photos_change_timestamp
  ));
  if (!eligible.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO app.trestle_media_queue (
       listing_key, source_record_id, photos_change_timestamp,
       expected_photo_count, status, attempts, available_at, completed_at,
       last_error, updated_at
     )
     SELECT listing_key, id, photos_change_timestamp, photos_count,
            'pending', 0, now(), NULL, NULL, now()
     FROM JSONB_TO_RECORDSET($1::jsonb) AS item(
       listing_key text, id bigint, photos_change_timestamp timestamptz,
       photos_count integer
     )
     ON CONFLICT (listing_key) DO UPDATE SET
       source_record_id = EXCLUDED.source_record_id,
       photos_change_timestamp = EXCLUDED.photos_change_timestamp,
       expected_photo_count = EXCLUDED.expected_photo_count,
       status = CASE
         WHEN app.trestle_media_queue.photos_change_timestamp IS DISTINCT FROM EXCLUDED.photos_change_timestamp
           OR app.trestle_media_queue.expected_photo_count IS DISTINCT FROM EXCLUDED.expected_photo_count
           THEN 'pending'
         ELSE app.trestle_media_queue.status
       END,
       attempts = CASE
         WHEN app.trestle_media_queue.photos_change_timestamp IS DISTINCT FROM EXCLUDED.photos_change_timestamp
           OR app.trestle_media_queue.expected_photo_count IS DISTINCT FROM EXCLUDED.expected_photo_count
           THEN 0 ELSE app.trestle_media_queue.attempts END,
       available_at = CASE
         WHEN app.trestle_media_queue.photos_change_timestamp IS DISTINCT FROM EXCLUDED.photos_change_timestamp
           OR app.trestle_media_queue.expected_photo_count IS DISTINCT FROM EXCLUDED.expected_photo_count
           THEN now() ELSE app.trestle_media_queue.available_at END,
       completed_at = CASE
         WHEN app.trestle_media_queue.photos_change_timestamp IS DISTINCT FROM EXCLUDED.photos_change_timestamp
           OR app.trestle_media_queue.expected_photo_count IS DISTINCT FROM EXCLUDED.expected_photo_count
           THEN NULL ELSE app.trestle_media_queue.completed_at END,
       updated_at = now()`,
    [JSON.stringify(eligible)],
  );
  return rowCount || eligible.length;
}

async function queuePropertyInfluences(client, persisted) {
  const accountIds = [...new Set(
    persisted.map((row) => row.primary_account_id).filter(Boolean),
  )];
  if (!accountIds.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO gis.property_influence_queue (
       account_id, reason, priority, status, available_at
     )
     SELECT account_id, 'trestle_listing_changed', 90, 'pending', now()
     FROM UNNEST($1::text[]) AS account_id
     ON CONFLICT (account_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       priority = GREATEST(gis.property_influence_queue.priority, EXCLUDED.priority),
       status = CASE WHEN gis.property_influence_queue.status = 'processing'
         THEN gis.property_influence_queue.status ELSE 'pending' END,
       available_at = CASE WHEN gis.property_influence_queue.status = 'processing'
         THEN gis.property_influence_queue.available_at ELSE now() END,
       updated_at = now(), completed_at = NULL`,
    [accountIds],
  );
  return rowCount || accountIds.length;
}

export async function persistTrestlePropertyBatch(pool, sourceRecords) {
  const mapped = [];
  const rejected = [];
  for (const sourceRecord of sourceRecords || []) {
    try {
      mapped.push(mapTrestleSourceRecord(sourceRecord));
    } catch (error) {
      rejected.push({
        listing_id: text(sourceRecord?.ListingId, 255),
        error: String(error?.message || error),
      });
    }
  }
  if (!mapped.length) return {
    received: (sourceRecords || []).length,
    upserted: 0,
    rejected,
    matched: 0,
    unmatched: 0,
    mediaQueued: 0,
    canonicalSales: 0,
  };
  const matches = await resolveTrestleAccountMatches(pool, mapped);
  const prepared = mapped.map((record) => persistenceRecord(record, matches.get(record.listing_key)));
  const client = await pool.connect();
  let persisted = [];
  let canonicalSales = 0;
  let mediaQueued = 0;
  try {
    await client.query("BEGIN");
    persisted = await upsertTrestleSourceRecords(client, prepared);
    const preparedByListingKey = new Map(
      prepared.map((record) => [record.listing_key, record]),
    );
    await rebuildParcelLinks(client, persisted);
    canonicalSales = await upsertCanonicalSales(client, persisted);
    await storeTrestlePropertyObservations(client, persisted, preparedByListingKey);
    await cacheTrestleCoordinates(client, persisted.map((row) => ({
      ...row,
      source_modified_at: preparedByListingKey.get(row.listing_key)?.source_modified_at,
    })));
    mediaQueued = await queueTrestleMedia(client, persisted);
    await queuePropertyInfluences(client, persisted);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const matched = persisted.filter((row) => row.primary_account_id).length;
  return {
    received: (sourceRecords || []).length,
    upserted: persisted.length,
    rejected,
    matched,
    unmatched: persisted.length - matched,
    mediaQueued,
    canonicalSales,
  };
}

function maximumModificationTimestamp(records, fallback) {
  let maximum = new Date(fallback || 0);
  for (const record of records || []) {
    const candidate = new Date(record?.ModificationTimestamp || 0);
    if (Number.isFinite(candidate.valueOf()) && candidate > maximum) maximum = candidate;
  }
  return maximum.toISOString();
}

async function acquireReplicationLock(pool) {
  const { rows } = await pool.query(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [TRESTLE_REPLICATION_LOCK_A, TRESTLE_REPLICATION_LOCK_B],
  );
  return Boolean(rows[0]?.acquired);
}

async function releaseReplicationLock(pool) {
  await pool.query(
    "SELECT pg_advisory_unlock($1, $2)",
    [TRESTLE_REPLICATION_LOCK_A, TRESTLE_REPLICATION_LOCK_B],
  );
}

export async function getTrestleReplicationStatus(pool, clientStatus = {}) {
  await ensureTrestleReplicationSchema(pool);
  const { rows } = await pool.query(
    `SELECT resource_name, cursor_timestamp, cursor_listing_key, status,
            last_started_at, last_completed_at, last_success_at, last_error,
            last_quota, updated_at
     FROM app.trestle_replication_state
     WHERE resource_name = 'Property'`,
  );
  const recent = await pool.query(
    `SELECT id, status, cursor_started_at, cursor_completed_at, page_count,
            records_received, records_upserted, records_rejected,
            matched_count, unmatched_count, media_queued_count,
            started_at, completed_at, error_message
     FROM app.trestle_replication_runs
     ORDER BY started_at DESC LIMIT 10`,
  );
  const media = await pool.query(
    `SELECT status, COUNT(*)::integer AS count
     FROM app.trestle_media_queue GROUP BY status`,
  );
  return {
    ...clientStatus,
    state: rows[0] || null,
    recent_runs: recent.rows,
    media_queue: Object.fromEntries(media.rows.map((row) => [row.status, Number(row.count)])),
  };
}

export async function runTrestlePropertyReplication(pool, trestleClient, {
  now = () => new Date(),
  maximumPages = trestleClient?.config?.maximumPages || 25,
  pageSize = trestleClient?.config?.pageSize || 1_000,
  persistBatch = persistTrestlePropertyBatch,
  logger = console,
} = {}) {
  const status = trestleClient.status();
  if (!status.replication_ready) {
    return {
      ok: true,
      skipped: true,
      reason: !status.configured
        ? "trestle_credentials_missing"
        : !status.enabled
          ? "trestle_disabled"
          : "trestle_replication_disabled",
    };
  }
  await ensureTrestleReplicationSchema(pool);
  const acquired = await acquireReplicationLock(pool);
  if (!acquired) return { ok: true, skipped: true, reason: "trestle_replication_already_running" };

  const workerId = `trestle-property-${randomUUID()}`;
  let runId = null;
  let cursorStartedAt = null;
  let cursorCompletedAt = null;
  const totals = {
    pages: 0,
    received: 0,
    upserted: 0,
    rejected: 0,
    matched: 0,
    unmatched: 0,
    mediaQueued: 0,
    canonicalSales: 0,
  };
  try {
    const state = await pool.query(
      `SELECT cursor_timestamp FROM app.trestle_replication_state
       WHERE resource_name = 'Property'`,
    );
    const configuredNow = now();
    const currentCursor = state.rows[0]?.cursor_timestamp
      ? new Date(state.rows[0].cursor_timestamp)
      : new Date(configuredNow.valueOf() - trestleClient.config.initialLookbackDays * 86_400_000);
    cursorStartedAt = new Date(
      currentCursor.valueOf() - trestleClient.config.overlapMinutes * 60_000,
    ).toISOString();
    cursorCompletedAt = currentCursor.toISOString();
    const run = await pool.query(
      `INSERT INTO app.trestle_replication_runs (
         worker_id, resource_name, status, cursor_started_at
       ) VALUES ($1,'Property','running',$2) RETURNING id`,
      [workerId, cursorStartedAt],
    );
    runId = run.rows[0].id;
    await pool.query(
      `INSERT INTO app.trestle_replication_state (
         resource_name, cursor_timestamp, status, last_run_id, last_started_at,
         last_error, updated_at
       ) VALUES ('Property',$1,'running',$2,now(),NULL,now())
       ON CONFLICT (resource_name) DO UPDATE SET
         status = 'running', last_run_id = EXCLUDED.last_run_id,
         last_started_at = now(), last_error = NULL, updated_at = now()`,
      [currentCursor.toISOString(), runId],
    );

    let nextLink = null;
    do {
      const payload = await trestleClient.propertyChangesPage({
        modifiedAfter: cursorStartedAt,
        nextLink,
        top: pageSize,
      });
      const records = Array.isArray(payload?.value) ? payload.value : [];
      const result = await persistBatch(pool, records);
      totals.pages += 1;
      totals.received += result.received;
      totals.upserted += result.upserted;
      totals.rejected += result.rejected.length;
      totals.matched += result.matched;
      totals.unmatched += result.unmatched;
      totals.mediaQueued += result.mediaQueued;
      totals.canonicalSales += result.canonicalSales;
      cursorCompletedAt = maximumModificationTimestamp(records, cursorCompletedAt);
      nextLink = payload?.["@odata.nextLink"] || null;
      await pool.query(
        `UPDATE app.trestle_replication_runs
         SET page_count = $2, records_received = $3, records_upserted = $4,
             records_rejected = $5, matched_count = $6, unmatched_count = $7,
             media_queued_count = $8, cursor_completed_at = $9,
             details = $10::jsonb
         WHERE id = $1`,
        [
          runId, totals.pages, totals.received, totals.upserted, totals.rejected,
          totals.matched, totals.unmatched, totals.mediaQueued, cursorCompletedAt,
          JSON.stringify({ canonical_sales: totals.canonicalSales, quota: trestleClient.lastQuota }),
        ],
      );
      // Page data is already committed. Advancing here makes a later page
      // failure resume near this checkpoint; the configured overlap still
      // replays the boundary safely on the next run.
      await pool.query(
        `UPDATE app.trestle_replication_state
         SET cursor_timestamp = $2, cursor_listing_key = $3,
             last_quota = $4::jsonb, updated_at = now()
         WHERE resource_name = 'Property' AND last_run_id = $1`,
        [
          runId,
          cursorCompletedAt,
          text(records.at(-1)?.ListingKey, 255),
          JSON.stringify(trestleClient.lastQuota || {}),
        ],
      );
      logger.info?.(
        `[trestle] page ${totals.pages}: ${result.upserted} upserted, ${result.matched} matched`,
      );
    } while (nextLink && totals.pages < maximumPages);

    const partial = Boolean(nextLink);
    await pool.query(
      `UPDATE app.trestle_replication_runs
       SET status = $2, completed_at = now(), cursor_completed_at = $3,
           details = details || $4::jsonb
       WHERE id = $1`,
      [runId, partial ? "partial" : "completed", cursorCompletedAt, JSON.stringify({ next_page_pending: partial })],
    );
    await pool.query(
      `UPDATE app.trestle_replication_state
       SET cursor_timestamp = $2, status = $3, last_completed_at = now(),
           last_success_at = now(), last_error = NULL, last_quota = $4::jsonb,
           updated_at = now()
       WHERE resource_name = 'Property' AND last_run_id = $1`,
      [runId, cursorCompletedAt, partial ? "partial" : "idle", JSON.stringify(trestleClient.lastQuota || {})],
    );
    return { ok: true, skipped: false, partial, run_id: runId, cursor_started_at: cursorStartedAt, cursor_completed_at: cursorCompletedAt, ...totals };
  } catch (error) {
    const message = String(error?.message || error || "trestle_replication_failed").slice(0, 4_000);
    if (runId) {
      await pool.query(
        `UPDATE app.trestle_replication_runs
         SET status = 'failed', completed_at = now(), error_message = $2
         WHERE id = $1`,
        [runId, message],
      ).catch(() => {});
      await pool.query(
        `UPDATE app.trestle_replication_state
         SET status = 'failed', last_completed_at = now(), last_error = $2,
             last_quota = $3::jsonb, updated_at = now()
         WHERE resource_name = 'Property' AND last_run_id = $1`,
        [runId, message, JSON.stringify(trestleClient.lastQuota || {})],
      ).catch(() => {});
    }
    throw error;
  } finally {
    await releaseReplicationLock(pool).catch(() => {});
  }
}

function mediaRetryDelayMinutes(attempts) {
  return Math.min(360, 2 ** Math.max(0, Number(attempts || 1) - 1) * 5);
}

export async function runTrestleMediaBatch(pool, trestleClient, {
  batchSize = 10,
  maximumAttempts = 5,
  workerId = `trestle-media-${randomUUID()}`,
} = {}) {
  if (!trestleClient.status().replication_ready || !trestleClient.config.mediaEnabled) {
    return { skipped: true, reason: "trestle_media_disabled", claimed: 0, completed: 0 };
  }
  await ensureTrestleReplicationSchema(pool);
  await pool.query(
    `UPDATE app.trestle_media_queue
     SET status = 'retry', available_at = now(), locked_at = NULL,
         locked_by = NULL, last_error = COALESCE(last_error, 'stale_media_claim_recovered'),
         updated_at = now()
     WHERE status = 'processing'
       AND locked_at < now() - interval '30 minutes'`,
  );
  const safeBatchSize = Math.max(1, Math.min(50, Math.trunc(Number(batchSize) || 10)));
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT listing_key FROM app.trestle_media_queue
       WHERE status IN ('pending','retry') AND available_at <= now()
       ORDER BY available_at, updated_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE app.trestle_media_queue queue
     SET status = 'processing', attempts = attempts + 1, locked_at = now(),
         locked_by = $2, updated_at = now()
     FROM candidates WHERE queue.listing_key = candidates.listing_key
     RETURNING queue.*`,
    [safeBatchSize, workerId],
  );
  let completed = 0;
  let retry = 0;
  let manualReview = 0;
  for (const item of rows) {
    try {
      const media = await trestleClient.mediaForProperty({ listingKey: item.listing_key });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM core.sales_source_media
           WHERE source_record_id = $1 AND source_filename = 'trestle://Media'`,
          [item.source_record_id],
        );
        const prepared = media
          .filter((record) => /^https?:\/\//i.test(String(record?.MediaURL || "")))
          .map((record, index) => ({
            source_record_id: item.source_record_id,
            media_key: text(record.MediaKey, 255),
            media_url: text(record.MediaURL, 8_000),
            media_category: String(record.MediaCategory || "image").toLowerCase() === "photo" ? "image" : text(record.MediaCategory, 100) || "image",
            mime_type: text(record.MediaType, 200),
            order_number: integerValue(record.Order) ?? index + 1,
            preferred_photo_yn: booleanValue(record.PreferredPhotoYN) || false,
            short_description: text(record.ShortDescription, 1_000),
            permission: text(record.Permission, 200),
            modification_timestamp: isoTimestamp(firstValue(record.MediaModificationTimestamp, record.ModificationTimestamp)),
            source_sha256: sha256(
              `trestle-media:${item.listing_key}:${record.MediaKey || record.MediaURL}`,
            ),
            raw_payload: record,
          }));
        if (prepared.length) {
          await client.query(
            `INSERT INTO core.sales_source_media (
               source_record_id, media_key, media_url, media_category, mime_type,
               order_number, preferred_photo_yn, short_description, permission,
               modification_timestamp, source_filename, source_sha256,
               source_row_number, raw_payload
             )
             SELECT source_record_id, media_key, media_url, media_category, mime_type,
                    order_number, preferred_photo_yn, short_description, permission,
                    modification_timestamp, 'trestle://Media', source_sha256,
                    order_number, raw_payload
             FROM JSONB_TO_RECORDSET($1::jsonb) AS row(
               source_record_id bigint, listing_key text, media_key text,
               media_url text, media_category text, mime_type text,
               order_number integer, preferred_photo_yn boolean,
               short_description text, permission text,
               modification_timestamp timestamptz, source_sha256 text,
               raw_payload jsonb
             )
             ON CONFLICT (source_record_id, media_url) DO UPDATE SET
               media_key = EXCLUDED.media_key, media_category = EXCLUDED.media_category,
               mime_type = EXCLUDED.mime_type, order_number = EXCLUDED.order_number,
               preferred_photo_yn = EXCLUDED.preferred_photo_yn,
               short_description = EXCLUDED.short_description,
               permission = EXCLUDED.permission,
               modification_timestamp = EXCLUDED.modification_timestamp,
               raw_payload = EXCLUDED.raw_payload, updated_at = now()`,
            [JSON.stringify(prepared.map((row) => ({ ...row, listing_key: item.listing_key })))],
          );
        }
        await client.query(
          `UPDATE app.trestle_media_queue
           SET status = 'completed', completed_at = now(), locked_at = NULL,
               locked_by = NULL, last_error = NULL, updated_at = now()
           WHERE listing_key = $1`,
          [item.listing_key],
        );
        await client.query("COMMIT");
        completed += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const review = Number(item.attempts) >= Number(maximumAttempts);
      await pool.query(
        `UPDATE app.trestle_media_queue
         SET status = $2,
             available_at = CASE WHEN $2 = 'retry'
               THEN now() + ($3::text || ' minutes')::interval ELSE available_at END,
             last_error = $4, locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE listing_key = $1`,
        [
          item.listing_key,
          review ? "manual_review" : "retry",
          mediaRetryDelayMinutes(item.attempts),
          String(error?.message || error).slice(0, 4_000),
        ],
      );
      if (review) manualReview += 1;
      else retry += 1;
    }
  }
  return { skipped: false, claimed: rows.length, completed, retry, manualReview };
}
