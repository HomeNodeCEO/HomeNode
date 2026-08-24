import { ensureAppraisalRatingsSchema } from "../services/appraisalRatings.js";
import { assertRedTeamFixtureAccountId } from "./redTeamIsolation.js";

export const REDTEAM_COMPARABLE_COUNT = 36;
export const REDTEAM_RECONCILIATION_COUNT = 2;
export const REDTEAM_COMPARABLE_SOURCE = "HomeNode synthetic red-team comparable fixture";
export const REDTEAM_RECONCILIATION_SOURCE = "HomeNode synthetic red-team reconciliation fixture";

const SUBJECT_EFFECTIVE_DATE = "2026-08-24";

function closeDate(index) {
  const zeroBasedMonth = 8 + (index % 12);
  const year = 2025 + Math.floor(zeroBasedMonth / 12);
  const month = (zeroBasedMonth % 12) + 1;
  const day = 5 + Math.floor(index / 12) * 7;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function comparableFixture(index) {
  const ordinal = index + 1;
  const accountId = assertRedTeamFixtureAccountId(
    `UAD-REDTEAM-COMP-${String(ordinal).padStart(4, "0")}`,
  );
  const livingArea = 1_650 + (index % 12) * 90;
  const yearBuilt = 1992 + (index % 18);
  const siteSize = 6_500 + (index % 9) * 550;
  const garageSpaces = index % 4 === 0 ? 1 : 2;
  const pool = index % 5 === 0;
  const bathroomsFull = 2 + (index % 3);
  const bathroomsHalf = index % 2;
  const basePrice = 130_000
    + livingArea * 115
    + (yearBuilt - 1990) * 1_500
    + garageSpaces * 10_000
    + (pool ? 22_000 : 0)
    + (index % 7) * 3_000;
  const salePrice = basePrice + (ordinal === REDTEAM_COMPARABLE_COUNT ? 180_000 : 0);
  const landValue = Math.round(siteSize * (7 + (index % 6) * 0.4));
  const improvementValue = Math.round(basePrice * (0.76 + (index % 4) * 0.02));
  const gridRow = Math.floor(index / 6) - 2.5;
  const gridColumn = (index % 6) - 2.5;
  const listingId = `RT-COMP-${String(ordinal).padStart(4, "0")}`;
  const conditionRatings = ["C2", "C3-C2", "C3", "C4-C3", "C4"];
  const qualityRatings = ["Q3", "Q4-Q3", "Q4"];
  return Object.freeze({
    account_id: accountId,
    address: `${400 + ordinal} Synthetic Comparable Ave`,
    city: "Garland",
    county: "Dallas",
    postal_code: "75044",
    neighborhood_code: "RT-001",
    subdivision: "Red Team Test Estates",
    legal_description: `LOT ${ordinal + 1} BLOCK R RED TEAM TEST ESTATES`,
    latitude: 32.95 + gridRow * 0.004,
    longitude: -96.65 + gridColumn * 0.004,
    living_area: livingArea,
    year_built: yearBuilt,
    site_size: siteSize,
    bedrooms: 3 + (index % 2),
    bathrooms_full: bathroomsFull,
    bathrooms_half: bathroomsHalf,
    garage_spaces: garageSpaces,
    pool,
    close_date: closeDate(index),
    sale_price: salePrice,
    land_value: landValue,
    improvement_value: improvementValue,
    market_value: landValue + improvementValue,
    days_on_market: 8 + (index * 7) % 73,
    listing_id: listingId,
    listing_key: `RT-LISTING-KEY-${String(ordinal).padStart(4, "0")}`,
    condition_rating: conditionRatings[index % conditionRatings.length],
    quality_rating: qualityRatings[index % qualityRatings.length],
  });
}

function reconciliationFixture(index) {
  const ordinal = index + 1;
  return Object.freeze({
    listing_id: `RT-RECON-${String(ordinal).padStart(4, "0")}`,
    listing_key: `RT-RECON-KEY-${String(ordinal).padStart(4, "0")}`,
    address: `${900 + ordinal} Unresolved Synthetic Sale Rd`,
    close_date: `2026-0${6 + index}-18`,
    sale_price: 390_000 + index * 35_000,
    parcel_number_raw: `RT-UNRESOLVED-${String(ordinal).padStart(4, "0")}`,
  });
}

export function buildRedTeamSalesFixtures() {
  const comparables = Array.from(
    { length: REDTEAM_COMPARABLE_COUNT },
    (_unused, index) => comparableFixture(index),
  );
  const reconciliation = Array.from(
    { length: REDTEAM_RECONCILIATION_COUNT },
    (_unused, index) => reconciliationFixture(index),
  );
  return Object.freeze({ comparables, reconciliation });
}

function comparableSourceRecords(comparables) {
  return comparables.map((fixture, index) => ({
    source_name: REDTEAM_COMPARABLE_SOURCE,
    source_filename: "redteam://synthetic-comparables",
    source_sha256: `redteam-comparable-${String(index + 1).padStart(4, "0")}`,
    source_row_number: index + 1,
    source_record_hash: `redteam-comparable-record-${String(index + 1).padStart(4, "0")}`,
    transaction_fingerprint: `redteam-comparable-transaction-${String(index + 1).padStart(4, "0")}`,
    listing_key: fixture.listing_key,
    listing_id: fixture.listing_id,
    primary_account_id: fixture.account_id,
    parcel_number_raw: fixture.account_id,
    bedrooms_total: fixture.bedrooms,
    bathrooms_total_integer: fixture.bathrooms_full + fixture.bathrooms_half,
    bathrooms_full: fixture.bathrooms_full,
    bathrooms_half: fixture.bathrooms_half,
    living_area: fixture.living_area,
    lot_size_area: fixture.site_size,
    current_price: fixture.sale_price,
    days_on_market: fixture.days_on_market,
    year_built: fixture.year_built,
    close_date: fixture.close_date,
    garage_spaces: fixture.garage_spaces,
    garage_yn: fixture.garage_spaces > 0,
    pool_yn: fixture.pool,
    listing_contract_date: fixture.close_date,
    mls_status: "Closed",
    match_status: "exact",
    has_unresolved_parcel: false,
    requires_additional_review: false,
    data_quality_flags: [],
    raw_payload: {
      synthetic: true,
      environment: "redteam",
      fixture_type: "comparable_closed_sale",
      Address: fixture.address,
      City: fixture.city,
      PostalCode: fixture.postal_code,
      Latitude: fixture.latitude,
      Longitude: fixture.longitude,
    },
  }));
}

function reconciliationSourceRecords(reconciliation) {
  return reconciliation.map((fixture, index) => ({
    source_name: REDTEAM_RECONCILIATION_SOURCE,
    source_filename: "redteam://synthetic-reconciliation",
    source_sha256: `redteam-reconciliation-${String(index + 1).padStart(4, "0")}`,
    source_row_number: index + 1,
    source_record_hash: `redteam-reconciliation-record-${String(index + 1).padStart(4, "0")}`,
    transaction_fingerprint: `redteam-reconciliation-transaction-${String(index + 1).padStart(4, "0")}`,
    listing_key: fixture.listing_key,
    listing_id: fixture.listing_id,
    primary_account_id: null,
    parcel_number_raw: fixture.parcel_number_raw,
    bedrooms_total: 3,
    bathrooms_total_integer: 2,
    bathrooms_full: 2,
    bathrooms_half: 0,
    living_area: 2_050 + index * 150,
    lot_size_area: 8_000 + index * 700,
    current_price: fixture.sale_price,
    days_on_market: 24 + index * 13,
    year_built: 2001 + index * 4,
    close_date: fixture.close_date,
    garage_spaces: 2,
    garage_yn: true,
    pool_yn: false,
    listing_contract_date: fixture.close_date,
    mls_status: "Closed",
    match_status: "unmatched",
    has_unresolved_parcel: true,
    requires_additional_review: true,
    data_quality_flags: ["synthetic_unresolved_parcel"],
    raw_payload: {
      synthetic: true,
      environment: "redteam",
      fixture_type: "reconciliation_queue",
      Address: fixture.address,
      City: "Garland",
      PostalCode: "75044",
    },
  }));
}

async function seedAccounts(pool, fixtures) {
  const payload = JSON.stringify(fixtures);
  await pool.query(
    `INSERT INTO core.accounts (
       account_id, county, address, street_name, city, postal_code,
       neighborhood_code, subdivision, legal_description, data_quality_status
     )
     SELECT account_id, county, address, upper(address), city, postal_code,
            neighborhood_code, subdivision, legal_description, 'synthetic'
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, county text, address text, city text, postal_code text,
       neighborhood_code text, subdivision text, legal_description text
     )
     ON CONFLICT (account_id) DO UPDATE SET
       county = EXCLUDED.county, address = EXCLUDED.address,
       street_name = EXCLUDED.street_name, city = EXCLUDED.city,
       postal_code = EXCLUDED.postal_code,
       neighborhood_code = EXCLUDED.neighborhood_code,
       subdivision = EXCLUDED.subdivision,
       legal_description = EXCLUDED.legal_description,
       data_quality_status = 'synthetic', updated_at = now()`,
    [payload],
  );
  await pool.query(
    `INSERT INTO core.account_locations (
       account_id, latitude, longitude, source_site_address,
       source_neighborhood_code, source_living_area_sqft, metadata, status,
       source, precision, confidence, match_method, geocoded_at, resolved_at
     )
     SELECT account_id, latitude, longitude, address, neighborhood_code,
            living_area, '{"synthetic":true,"environment":"redteam","fixture_type":"comparable"}'::jsonb,
            'matched', 'redteam_fixture', 'synthetic_point', 'high',
            'synthetic_fixture', now(), now()
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, latitude double precision, longitude double precision,
       address text, neighborhood_code text, living_area integer
     )
     ON CONFLICT (account_id) DO UPDATE SET
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       source_site_address = EXCLUDED.source_site_address,
       source_neighborhood_code = EXCLUDED.source_neighborhood_code,
       source_living_area_sqft = EXCLUDED.source_living_area_sqft,
       metadata = EXCLUDED.metadata, status = EXCLUDED.status,
       source = EXCLUDED.source, precision = EXCLUDED.precision,
       confidence = EXCLUDED.confidence, match_method = EXCLUDED.match_method,
       resolved_at = EXCLUDED.resolved_at, updated_at = now()`,
    [payload],
  );
  await pool.query(
    `INSERT INTO core.primary_improvements (
       account_id, year_built, living_area_sqft, bedroom_count, bath_count,
       baths_full, baths_half, number_units, construction_type
     )
     SELECT account_id, year_built, living_area, bedrooms,
            bathrooms_full + bathrooms_half * 0.5,
            bathrooms_full, bathrooms_half, 1, 'Frame'
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, year_built integer, living_area integer, bedrooms integer,
       bathrooms_full integer, bathrooms_half integer
     )
     ON CONFLICT (account_id) DO UPDATE SET
       year_built = EXCLUDED.year_built,
       living_area_sqft = EXCLUDED.living_area_sqft,
       bedroom_count = EXCLUDED.bedroom_count,
       bath_count = EXCLUDED.bath_count,
       baths_full = EXCLUDED.baths_full,
       baths_half = EXCLUDED.baths_half,
       number_units = EXCLUDED.number_units,
       construction_type = EXCLUDED.construction_type`,
    [payload],
  );
  await pool.query(
    `INSERT INTO core.land_detail (
       account_id, tax_year, line_number, zoning, area_sqft
     )
     SELECT account_id, 2026, 1, 'SF-7', site_size
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, site_size numeric
     )
     ON CONFLICT (account_id, tax_year, line_number) DO UPDATE SET
       zoning = EXCLUDED.zoning, area_sqft = EXCLUDED.area_sqft`,
    [payload],
  );
  await pool.query(
    `INSERT INTO core.value_summary_current (
       account_id, certified_year, market_value, improvement_value,
       land_value, capped_value
     )
     SELECT account_id, 2026, market_value, improvement_value,
            land_value, market_value
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, market_value numeric, improvement_value numeric,
       land_value numeric
     )
     ON CONFLICT (account_id) DO UPDATE SET
       certified_year = EXCLUDED.certified_year,
       market_value = EXCLUDED.market_value,
       improvement_value = EXCLUDED.improvement_value,
       land_value = EXCLUDED.land_value,
       capped_value = EXCLUDED.capped_value`,
    [payload],
  );
  await pool.query(
    `INSERT INTO core.account_housing_profiles (
       account_id, structural_style, housing_type, attachment_type,
       architectural_style, source_name, source_record_reference,
       observed_at, confidence, notes
     )
     SELECT account_id, 'Single Family', 'Single Family Residence', 'detached',
            'Traditional', $2, listing_id, now(), 1.000,
            'Synthetic comparable classification'
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       account_id text, listing_id text
     )
     ON CONFLICT (account_id) DO UPDATE SET
       structural_style = EXCLUDED.structural_style,
       housing_type = EXCLUDED.housing_type,
       attachment_type = EXCLUDED.attachment_type,
       architectural_style = EXCLUDED.architectural_style,
       source_name = EXCLUDED.source_name,
       source_record_reference = EXCLUDED.source_record_reference,
       observed_at = EXCLUDED.observed_at,
       confidence = EXCLUDED.confidence,
       notes = EXCLUDED.notes,
       updated_at = now()`,
    [payload, REDTEAM_COMPARABLE_SOURCE],
  );
}

async function seedSourceRecords(pool, records) {
  await pool.query(
    `INSERT INTO core.sales_source_records (
       source_name, source_filename, source_sha256, source_row_number,
       source_record_hash, transaction_fingerprint, listing_key, listing_id,
       primary_account_id, parcel_number_raw, bedrooms_total,
       bathrooms_total_integer, bathrooms_full, bathrooms_half, living_area,
       lot_size_area, current_price, days_on_market, year_built, close_date,
       garage_spaces, garage_yn, pool_yn, listing_contract_date, mls_status,
       record_type, structural_style, housing_type, attachment_type,
       architectural_style, match_status, has_unresolved_parcel,
       requires_additional_review, data_quality_flags, raw_payload
     )
     SELECT source_name, source_filename, source_sha256, source_row_number,
            source_record_hash, transaction_fingerprint, listing_key, listing_id,
            primary_account_id, parcel_number_raw, bedrooms_total,
            bathrooms_total_integer, bathrooms_full, bathrooms_half, living_area,
            lot_size_area, current_price, days_on_market, year_built, close_date,
            garage_spaces, garage_yn, pool_yn, listing_contract_date, mls_status,
            'closed_sale', 'Single Family', 'Single Family Residence', 'detached',
            'Traditional', match_status, has_unresolved_parcel,
            requires_additional_review, data_quality_flags, raw_payload
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       source_name text, source_filename text, source_sha256 text,
       source_row_number integer, source_record_hash text,
       transaction_fingerprint text, listing_key text, listing_id text,
       primary_account_id text, parcel_number_raw text, bedrooms_total integer,
       bathrooms_total_integer integer, bathrooms_full integer,
       bathrooms_half integer, living_area numeric, lot_size_area numeric,
       current_price numeric, days_on_market integer, year_built integer,
       close_date date, garage_spaces numeric, garage_yn boolean, pool_yn boolean,
       listing_contract_date date, mls_status text, match_status text,
       has_unresolved_parcel boolean, requires_additional_review boolean,
       data_quality_flags jsonb, raw_payload jsonb
     )
     ON CONFLICT (source_record_hash) DO UPDATE SET
       listing_key = EXCLUDED.listing_key, listing_id = EXCLUDED.listing_id,
       primary_account_id = EXCLUDED.primary_account_id,
       parcel_number_raw = EXCLUDED.parcel_number_raw,
       bedrooms_total = EXCLUDED.bedrooms_total,
       bathrooms_total_integer = EXCLUDED.bathrooms_total_integer,
       bathrooms_full = EXCLUDED.bathrooms_full,
       bathrooms_half = EXCLUDED.bathrooms_half,
       living_area = EXCLUDED.living_area, lot_size_area = EXCLUDED.lot_size_area,
       current_price = EXCLUDED.current_price, days_on_market = EXCLUDED.days_on_market,
       year_built = EXCLUDED.year_built, close_date = EXCLUDED.close_date,
       garage_spaces = EXCLUDED.garage_spaces, garage_yn = EXCLUDED.garage_yn,
       pool_yn = EXCLUDED.pool_yn,
       listing_contract_date = EXCLUDED.listing_contract_date,
       mls_status = EXCLUDED.mls_status, match_status = EXCLUDED.match_status,
       has_unresolved_parcel = EXCLUDED.has_unresolved_parcel,
       requires_additional_review = EXCLUDED.requires_additional_review,
       data_quality_flags = EXCLUDED.data_quality_flags,
       raw_payload = EXCLUDED.raw_payload, updated_at = now()`,
    [JSON.stringify(records)],
  );
  await pool.query(
    `INSERT INTO core.sale_parcels (
       source_record_id, source_position, parcel_sequence, parcel_role,
       parcel_number_raw, parcel_number_normalized, account_id,
       match_method, is_resolved
     )
     SELECT source.id, 1, 1, 'primary', source.parcel_number_raw,
            source.primary_account_id, source.primary_account_id,
            CASE WHEN source.primary_account_id IS NULL THEN 'unmatched' ELSE 'exact' END,
            source.primary_account_id IS NOT NULL
     FROM core.sales_source_records source
     WHERE source.source_name = ANY($1::text[])
     ON CONFLICT (source_record_id, source_position, parcel_sequence) DO UPDATE SET
       parcel_number_raw = EXCLUDED.parcel_number_raw,
       parcel_number_normalized = EXCLUDED.parcel_number_normalized,
       account_id = EXCLUDED.account_id,
       match_method = EXCLUDED.match_method,
       is_resolved = EXCLUDED.is_resolved`,
    [[REDTEAM_COMPARABLE_SOURCE, REDTEAM_RECONCILIATION_SOURCE]],
  );
}

async function seedRatings(pool, subjectAccountId, comparables) {
  await ensureAppraisalRatingsSchema(pool);
  await pool.query(
    `INSERT INTO app.sale_characteristic_reviews (
       source_record_id, listing_id, condition_rating, quality_rating,
       notes, reviewer, revision
     )
     SELECT source.id, source.listing_id, fixture.condition_rating,
            fixture.quality_rating, 'Synthetic comparable rating', $2, 1
     FROM jsonb_to_recordset($1::jsonb) AS fixture(
       listing_id text, condition_rating text, quality_rating text
     )
     JOIN core.sales_source_records source USING (listing_id)
     WHERE source.source_name = $3
     ON CONFLICT (source_record_id) DO UPDATE SET
       listing_id = EXCLUDED.listing_id,
       condition_rating = EXCLUDED.condition_rating,
       quality_rating = EXCLUDED.quality_rating,
       notes = EXCLUDED.notes, reviewer = EXCLUDED.reviewer,
       revision = 1, updated_at = now()`,
    [JSON.stringify(comparables), REDTEAM_COMPARABLE_SOURCE, REDTEAM_COMPARABLE_SOURCE],
  );
  await pool.query(
    `INSERT INTO app.subject_appraisal_ratings (
       account_id, effective_date, condition_rating, quality_rating,
       notes, reviewer, revision
     ) VALUES ($1, $2::date, 'C3', 'Q3', 'Synthetic subject rating', $3, 1)
     ON CONFLICT (account_id, effective_date) DO UPDATE SET
       condition_rating = EXCLUDED.condition_rating,
       quality_rating = EXCLUDED.quality_rating,
       notes = EXCLUDED.notes, reviewer = EXCLUDED.reviewer,
       revision = 1, updated_at = now()`,
    [subjectAccountId, SUBJECT_EFFECTIVE_DATE, REDTEAM_COMPARABLE_SOURCE],
  );
}

export async function seedRedTeamSalesFixtures(pool, subjectAccountId) {
  const safeSubjectAccountId = assertRedTeamFixtureAccountId(subjectAccountId);
  const fixtures = buildRedTeamSalesFixtures();
  await seedAccounts(pool, fixtures.comparables);
  await seedSourceRecords(pool, [
    ...comparableSourceRecords(fixtures.comparables),
    ...reconciliationSourceRecords(fixtures.reconciliation),
  ]);
  await seedRatings(pool, safeSubjectAccountId, fixtures.comparables);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE source_name = $1)::integer AS comparable_sales,
       COUNT(*) FILTER (WHERE source_name = $2)::integer AS reconciliation_sales,
       COUNT(*) FILTER (
         WHERE source_name = $1 AND primary_account_id LIKE 'UAD-REDTEAM-COMP-%'
       )::integer AS linked_comparable_sales
     FROM core.sales_source_records
     WHERE source_name IN ($1, $2)`,
    [REDTEAM_COMPARABLE_SOURCE, REDTEAM_RECONCILIATION_SOURCE],
  );
  const counts = rows[0] || {};
  if (
    Number(counts.comparable_sales) !== REDTEAM_COMPARABLE_COUNT
    || Number(counts.linked_comparable_sales) !== REDTEAM_COMPARABLE_COUNT
    || Number(counts.reconciliation_sales) !== REDTEAM_RECONCILIATION_COUNT
  ) {
    throw new Error("redteam_sales_fixture_count_mismatch");
  }
  return Object.freeze({
    comparable_sales: Number(counts.comparable_sales),
    reconciliation_sales: Number(counts.reconciliation_sales),
    rated_comparables: fixtures.comparables.length,
    synthetic_only: true,
  });
}
