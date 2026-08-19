import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createUadWorkfile } from "../src/modules/uad/workfiles.js";

const SFR_ACCOUNT_ID = "UAD-STAGING-SFR-0001";
const SFR_FILE_NUMBER = "HN-UAD-STAGING-SFR-0001";
const MANUFACTURED_HOME_ACCOUNT_ID = "UAD-STAGING-MH-0001";
const MANUFACTURED_HOME_FILE_NUMBER = "HN-UAD-STAGING-MH-0001";
const STAGING_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000901";
const STAGING_USER_ID = "00000000-0000-4000-8000-000000000902";
const STAGING_USER_EMAIL = "mobile-appraiser@staging.homenode.invalid";

if (process.env.NODE_ENV !== "staging") {
  throw new Error("prepareUadStagingDatabase may only run with NODE_ENV=staging");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function ensureEntity(workfileId, parentEntityId, entityType, entityIdentifier, ordinal, label, data = {}) {
  const existing = await pool.query(
    `SELECT id FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = $2 AND entity_identifier = $3`,
    [workfileId, entityType, entityIdentifier],
  );
  if (existing.rows.length) {
    if (Object.keys(data).length) {
      await pool.query(
        `UPDATE appraisal.uad_entities SET data = data || $2::jsonb, updated_at = now() WHERE id = $1`,
        [existing.rows[0].id, JSON.stringify(data)],
      );
    }
    return existing.rows[0].id;
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO appraisal.uad_entities (
       id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label, data
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [id, workfileId, parentEntityId, entityType, entityIdentifier, ordinal, label, JSON.stringify(data)],
  );
  return id;
}

async function seedEntityValue(workfileId, entityId, context, uid, reportFieldId, value) {
  await pool.query(
    `INSERT INTO appraisal.uad_field_values (
       id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
       source_type, source_reference, source_observed_at, is_appraiser_confirmed
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb,
       'calculated', 'uad_staging_fixture', now(), false
     )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), workfileId, entityId, context, uid, reportFieldId, JSON.stringify(value)],
  );
}
try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  const databaseName = String(identity.rows[0]?.database_name || "");
  if (!databaseName.toLowerCase().includes("staging")) {
    throw new Error("staging bootstrap refused a non-staging database");
  }

  await pool.query(
    `INSERT INTO app_auth.organizations (
       id, legal_name, display_name, active, metadata
     ) VALUES ($1, 'HomeNode Staging', 'HomeNode Staging', true, '{"synthetic":true,"environment":"staging"}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       legal_name = EXCLUDED.legal_name,
       display_name = EXCLUDED.display_name,
       active = true,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [STAGING_ORGANIZATION_ID],
  );

  await pool.query(
    `INSERT INTO app_auth.users (
       id, email, display_name, active, metadata
     ) VALUES ($1, $2, 'Mobile Staging Appraiser', true, '{"synthetic":true,"environment":"staging"}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       active = true,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [STAGING_USER_ID, STAGING_USER_EMAIL],
  );

  await pool.query(
    `INSERT INTO app_auth.organization_memberships (
       organization_id, user_id, status
     ) VALUES ($1, $2, 'active')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET
       status = 'active',
       updated_at = now()`,
    [STAGING_ORGANIZATION_ID, STAGING_USER_ID],
  );

  await pool.query(
    `INSERT INTO app_auth.membership_roles (
       organization_id, user_id, role_code
     ) VALUES ($1, $2, 'appraiser')
     ON CONFLICT (organization_id, user_id, role_code) DO NOTHING`,
    [STAGING_ORGANIZATION_ID, STAGING_USER_ID],
  );

  await pool.query(
    `INSERT INTO app_auth.appraiser_profiles (
       user_id, default_organization_id, signature_policy, profile_status, metadata
     ) VALUES ($1, $2, 'reauthentication', 'active', '{"synthetic":true,"environment":"staging"}'::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       default_organization_id = EXCLUDED.default_organization_id,
       signature_policy = EXCLUDED.signature_policy,
       profile_status = 'active',
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [STAGING_USER_ID, STAGING_ORGANIZATION_ID],
  );

  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS core.accounts (
      account_id text PRIMARY KEY,
      county text,
      address text,
      street_name text,
      city text,
      postal_code text,
      neighborhood_code text,
      subdivision text,
      legal_description text,
      data_quality_status text,
      data_quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
      canonical_account_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE core.accounts
      ADD COLUMN IF NOT EXISTS street_name text,
      ADD COLUMN IF NOT EXISTS data_quality_status text,
      ADD COLUMN IF NOT EXISTS data_quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
      ADD COLUMN IF NOT EXISTS canonical_account_id text;

    CREATE TABLE IF NOT EXISTS core.account_locations (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      latitude double precision,
      longitude double precision,
      source_site_address text,
      source_neighborhood_code text,
      source_living_area_sqft integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    ALTER TABLE core.account_locations
      ADD COLUMN IF NOT EXISTS source_site_address text,
      ADD COLUMN IF NOT EXISTS source_neighborhood_code text,
      ADD COLUMN IF NOT EXISTS source_living_area_sqft integer,
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'matched',
      ADD COLUMN IF NOT EXISTS attempted_at timestamptz,
      ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
      ADD COLUMN IF NOT EXISTS failure_reason text,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS core.primary_improvements (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      year_built integer,
      living_area_sqft integer,
      bedroom_count integer,
      bath_count numeric,
      number_units integer,
      construction_type text
    );

    ALTER TABLE core.primary_improvements
      ADD COLUMN IF NOT EXISTS construction_type text;

    CREATE TABLE IF NOT EXISTS core.land_detail (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      line_number integer NOT NULL,
      zoning text,
      frontage_ft numeric,
      depth_ft numeric,
      area_sqft numeric,
      UNIQUE (account_id, tax_year, line_number)
    );

    ALTER TABLE core.land_detail
      ADD COLUMN IF NOT EXISTS zoning text,
      ADD COLUMN IF NOT EXISTS frontage_ft numeric,
      ADD COLUMN IF NOT EXISTS depth_ft numeric;

    CREATE UNIQUE INDEX IF NOT EXISTS uad_staging_land_detail_identity_idx
      ON core.land_detail (account_id, tax_year, line_number);

    CREATE TABLE IF NOT EXISTS core.secondary_improvements (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      sec_imp_number integer,
      sec_imp_type text,
      sec_imp_sqft integer,
      sec_imp_year_built integer
    );

    ALTER TABLE core.secondary_improvements
      ADD COLUMN IF NOT EXISTS sec_imp_year_built integer;

    -- The normal HomeNode search tile joins these optional enrichment sources.
    -- Empty staging-compatible relations keep that shared search path usable
    -- without copying production owner, sales, or tax records.
    CREATE TABLE IF NOT EXISTS app.county_account_identifiers (
      county text NOT NULL,
      normalized_account_id text NOT NULL,
      native_account_id text NOT NULL,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      verification_source text NOT NULL DEFAULT 'staging_fixture',
      source_record_id bigint,
      reviewer text,
      verified_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (county, normalized_account_id)
    );

    CREATE INDEX IF NOT EXISTS county_account_identifiers_account_idx
      ON app.county_account_identifiers (account_id, county);

    CREATE TABLE IF NOT EXISTS core.value_summary_current (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      certified_year integer,
      market_value numeric,
      improvement_value numeric,
      land_value numeric,
      capped_value numeric
    );

    CREATE TABLE IF NOT EXISTS core.market_values (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      total_value numeric,
      imp_value numeric,
      land_value numeric,
      homestead_cap_value numeric,
      UNIQUE (account_id, tax_year)
    );

    CREATE TABLE IF NOT EXISTS core.dcad_json_raw (
      account_id text NOT NULL,
      tax_year integer NOT NULL,
      source_url text,
      raw jsonb NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, tax_year)
    );

    INSERT INTO core.accounts (
      account_id, county, address, street_name, city, postal_code, neighborhood_code,
      subdivision, legal_description
    ) VALUES
      (
        'UAD-STAGING-SFR-0001', 'Dallas', '100 Test Subject Dr', 'TEST SUBJECT DR',
        'Garland', '75044',
        'STG-001', 'Test Estates', 'LOT 1 BLOCK A TEST ESTATES'
      ),
      (
        'UAD-STAGING-MH-0001', 'Dallas', '200 Factory Home Way', 'FACTORY HOME WAY',
        'Garland', '75044',
        'STG-MH-001', 'Factory Home Estates', 'LOT 2 BLOCK M FACTORY HOME ESTATES'
      )
    ON CONFLICT (account_id) DO UPDATE SET
      county = EXCLUDED.county,
      address = EXCLUDED.address,
      street_name = EXCLUDED.street_name,
      city = EXCLUDED.city,
      postal_code = EXCLUDED.postal_code,
      neighborhood_code = EXCLUDED.neighborhood_code,
      subdivision = EXCLUDED.subdivision,
      legal_description = EXCLUDED.legal_description,
      updated_at = now();

    INSERT INTO core.account_locations (
      account_id, latitude, longitude, source_site_address,
      source_neighborhood_code, source_living_area_sqft, metadata
    ) VALUES
      (
        'UAD-STAGING-SFR-0001', 32.9500, -96.6500, '100 Test Subject Dr',
        'STG-001', 2100, '{"source_state":"TX","synthetic":true,"fixture_type":"site_built_sfr"}'::jsonb
      ),
      (
        'UAD-STAGING-MH-0001', 32.9510, -96.6510, '200 Factory Home Way',
        'STG-MH-001', 1600, '{"source_state":"TX","synthetic":true,"fixture_type":"manufactured_home"}'::jsonb
      )
    ON CONFLICT (account_id) DO UPDATE SET
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      source_site_address = EXCLUDED.source_site_address,
      source_neighborhood_code = EXCLUDED.source_neighborhood_code,
      source_living_area_sqft = EXCLUDED.source_living_area_sqft,
      metadata = EXCLUDED.metadata,
      status = 'matched',
      updated_at = now();

    INSERT INTO core.primary_improvements (
      account_id, year_built, living_area_sqft, bedroom_count, bath_count,
      number_units, construction_type
    ) VALUES
      ('UAD-STAGING-SFR-0001', 2005, 2100, 3, 2.5, 1, 'Frame'),
      ('UAD-STAGING-MH-0001', 2024, 1600, 3, 2, 1, 'Manufactured')
    ON CONFLICT (account_id) DO UPDATE SET
      year_built = EXCLUDED.year_built,
      living_area_sqft = EXCLUDED.living_area_sqft,
      bedroom_count = EXCLUDED.bedroom_count,
      bath_count = EXCLUDED.bath_count,
      number_units = EXCLUDED.number_units,
      construction_type = EXCLUDED.construction_type;

    INSERT INTO core.land_detail (
      account_id, tax_year, line_number, zoning, frontage_ft, depth_ft, area_sqft
    ) VALUES
      ('UAD-STAGING-SFR-0001', 2026, 1, 'SF-7', 70, 120, 8400),
      ('UAD-STAGING-MH-0001', 2026, 1, 'MH', 60, 110, 6600)
    ON CONFLICT (account_id, tax_year, line_number) DO UPDATE SET
      zoning = EXCLUDED.zoning,
      frontage_ft = EXCLUDED.frontage_ft,
      depth_ft = EXCLUDED.depth_ft,
      area_sqft = EXCLUDED.area_sqft;

    INSERT INTO core.value_summary_current (
      account_id, certified_year, market_value, improvement_value, land_value, capped_value
    ) VALUES
      ('UAD-STAGING-SFR-0001', 2026, 425000, 350000, 75000, 410000),
      ('UAD-STAGING-MH-0001', 2026, 240000, 190000, 50000, 230000)
    ON CONFLICT (account_id) DO UPDATE SET
      certified_year = EXCLUDED.certified_year,
      market_value = EXCLUDED.market_value,
      improvement_value = EXCLUDED.improvement_value,
      land_value = EXCLUDED.land_value,
      capped_value = EXCLUDED.capped_value;
  `);

  let sfrWorkfileResult = await pool.query(
    `SELECT id
       FROM appraisal.uad_workfiles
      WHERE account_id = $1 AND lower(file_number) = lower($2)
      ORDER BY created_at, id
      LIMIT 1`,
    [SFR_ACCOUNT_ID, SFR_FILE_NUMBER],
  );
  if (!sfrWorkfileResult.rows.length) {
    await createUadWorkfile(pool, SFR_ACCOUNT_ID, {
      file_number: SFR_FILE_NUMBER,
      assignment_purpose: "Synthetic site-built Sections 10-19 staging validation",
    });
    sfrWorkfileResult = await pool.query(
      `SELECT id
         FROM appraisal.uad_workfiles
        WHERE account_id = $1 AND lower(file_number) = lower($2)
        ORDER BY created_at, id
        LIMIT 1`,
      [SFR_ACCOUNT_ID, SFR_FILE_NUMBER],
    );
  }

  const sfrWorkfileId = sfrWorkfileResult.rows[0].id;
  await seedEntityValue(sfrWorkfileId, null, "subject", "0100.0026", "3.010", true);
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET value = 'true'::jsonb,
            source_type = 'calculated',
            source_reference = 'uad_staging_fixture',
            is_appraiser_confirmed = false,
            updated_at = now()
      WHERE workfile_id = $1
        AND entity_id IS NULL
        AND field_context = 'subject'
        AND uad_uid = '0100.0026'`,
    [sfrWorkfileId],
  );
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "subject",
    "0100.0046",
    "3.016",
    true,
  );
  const sfrDwellingResult = await pool.query(
    `SELECT id
       FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = 'dwelling'
      ORDER BY ordinal, id
      LIMIT 1`,
    [sfrWorkfileId],
  );
  if (!sfrDwellingResult.rows.length) throw new Error("site-built staging workfile is missing its dwelling entity");
  const sfrDwellingId = sfrDwellingResult.rows[0].id;
  await seedEntityValue(sfrWorkfileId, sfrDwellingId, "dwelling", "1600.0005", "8.022", "Q3");
  await seedEntityValue(sfrWorkfileId, sfrDwellingId, "dwelling", "1600.0004", "8.023", "C3");
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "functional_obsolescence",
    "3600.0002",
    "11.000",
    ["None"],
  );
  const outbuildingId = await ensureEntity(
    sfrWorkfileId,
    null,
    "outbuilding",
    "outbuilding-shed-1",
    1,
    "Shed 1",
  );
  const outbuildingValues = [
    ["0300.0025", "12.001", "Shed"],
    ["0300.0024", "12.002", true],
    ["0300.0063", "12.003", 0],
    ["0300.0060", "12.006", { amount: 240, unit: "SquareFeet" }],
    ["0300.0023", "12.008", false],
    ["0300.0022", "12.009 / 12.016", false],
    ["0300.0028", "12.010", ["Electricity"]],
    ["0300.0112", "12.011", { amount: 0, unit: "SquareFeet" }],
    ["0300.0113", "12.013", { amount: 240, unit: "SquareFeet" }],
    ["0300.0111", "12.019", false],
    ["0300.0096", "12.025", "Detached storage shed included as real property."],
  ];
  for (const [uid, reportFieldId, value] of outbuildingValues) {
    await seedEntityValue(sfrWorkfileId, outbuildingId, "outbuilding", uid, reportFieldId, value);
  }
  const vehicleStorageId = await ensureEntity(
    sfrWorkfileId,
    null,
    "vehicle_storage",
    "vehicle-storage-1",
    1,
    "Garage 1",
  );
  const vehicleStorageValues = [
    ["3200.0006", "13.001", "Garage"],
    ["3200.0010", "13.002", 2],
    ["3200.0005", "13.003", "Attached"],
    ["3200.0004", "13.003", { amount: 440, unit: "SquareFeet" }],
  ];
  for (const [uid, reportFieldId, value] of vehicleStorageValues) {
    await seedEntityValue(sfrWorkfileId, vehicleStorageId, "vehicle_storage", uid, reportFieldId, value);
  }
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "vehicle_storage",
    "3200.0021",
    "13.004",
    false,
  );
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "subject_property_amenities",
    "0200.0015",
    "14.000",
    true,
  );
  const amenityId = await ensureEntity(
    sfrWorkfileId,
    null,
    "amenity",
    "amenity-outdoor-living-deck-1",
    1,
    "Outdoor Living 1",
    { amenity_category: "OutdoorLiving" },
  );
  const amenityValues = [
    ["0200.0017", "14.001", "OutdoorLiving"],
    ["0200.0023", "14.002 / 14.006", "Deck"],
    ["0200.0021", "14.003", "Wood"],
    ["0200.0025", "14.004", { amount: 240, unit: "SquareFeet" }],
  ];
  for (const [uid, reportFieldId, value] of amenityValues) {
    await seedEntityValue(sfrWorkfileId, amenityId, "amenity_outdoor_living", uid, reportFieldId, value);
  }
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "subject_property_amenities",
    "0200.0053",
    "14.005",
    false,
  );
  const sfrUnitResult = await pool.query(
    `SELECT id
       FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = 'unit'
      ORDER BY ordinal, id
      LIMIT 1`,
    [sfrWorkfileId],
  );
  if (!sfrUnitResult.rows.length) throw new Error("site-built staging workfile is missing its unit entity");
  const sfrUnitId = sfrUnitResult.rows[0].id;

  const unitValues = [
    ["unit", "0700.0140", "10.003", { amount: 2100, unit: "SquareFeet" }],
    ["unit", "0700.0141", "10.004", { amount: 0, unit: "SquareFeet" }],
    ["unit", "0700.0142", "10.005", { amount: 0, unit: "SquareFeet" }],
    ["unit", "0700.0143", "10.006", { amount: 0, unit: "SquareFeet" }],
    ["unit", "1800.0398", "10.007", { amount: 0, unit: "SquareFeet" }],
    ["unit", "0700.0144", "10.008", { amount: 0, unit: "SquareFeet" }],
    ["unit", "0700.0089", "10.011", false],
    ["unit", "0700.0063", "10.017", 1],
    ["unit", "0700.0070", "10.020", "OwnerOccupied"],
    ["unit", "0700.0118", "10.023", 3],
    ["unit", "0700.0119", "10.024", 2],
    ["unit", "0700.0120", "10.025", 0],
    ["unit", "0700.0067", "10.034", "Q3"],
    ["unit", "0700.0066", "10.035", "C3"],
    ["unit", "0700.0117", "10.043", "NotUpdated"],
    ["unit", "0700.0122", "10.049", "NotUpdated"],
    ["unit_accessibility", "0700.0005", "10.050", ["None"]],
    ["unit", "3900.0107", "10.055", false],
  ];
  for (const [context, uid, reportFieldId, value] of unitValues) {
    await seedEntityValue(sfrWorkfileId, sfrUnitId, context, uid, reportFieldId, value);
  }
  await seedEntityValue(sfrWorkfileId, null, "subject", "1600.0007", "15.000", "Q3");
  await seedEntityValue(sfrWorkfileId, null, "subject", "1600.0006", "15.005", "C3");
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "overall_quality_condition_commentary",
    "1600.0008",
    "15.010",
    "The Q3 and C3 overall ratings reconcile the dwelling exterior and non-ADU unit interior ratings.",
  );
  const highestBestUseValues = [
    ["3100.0004", "16.000", true],
    ["3100.0006", "16.001", true],
    ["3100.0003", "16.002", true],
    ["3100.0005", "16.003", true],
    ["3100.0007", "16.004", true],
  ];
  for (const [uid, reportFieldId, value] of highestBestUseValues) {
    await seedEntityValue(sfrWorkfileId, null, "highest_best_use", uid, reportFieldId, value);
  }
  await seedEntityValue(
    sfrWorkfileId,
    null,
    "highest_best_use_commentary",
    "3100.0010",
    "16.005",
    "The present single-family residential use is legally permissible, physically possible, financially feasible, and maximally productive.",
  );

  const marketPriceTrendSourceId = await ensureEntity(
    sfrWorkfileId,
    null,
    "market_price_trend_source",
    "market-price-trend-source-1",
    1,
    "Price Trend Source 1",
  );
  const marketValues = [
    [null, "market", "3000.0008", "17.003", "North: North Test Rd; East: East Test Ave; South: South Test Blvd; West: West Test Dr."],
    [null, "market", "3000.0010", "17.004", "Detached single-family properties within the defined test market, including active, pending, and closed sales over the prior 12 months."],
    [null, "market_active_listings", "3000.0018", "17.005", 3],
    [null, "market_active_listings", "3000.0021", "17.006", 24],
    [null, "market_active_listings", "3000.0020", "17.007", 399000],
    [null, "market_active_listings", "3000.0022", "17.008", 425000],
    [null, "market_active_listings", "3000.0019", "17.009", 465000],
    [null, "market_pending_sales", "3000.0024", "17.010", 2],
    [null, "market", "3000.0009", "17.011", 12],
    [null, "market_total_sales", "3000.0026", "17.012", 8],
    [null, "market_total_sales", "3000.0028", "17.013", 365000],
    [null, "market_total_sales", "3000.0029", "17.014", 418000],
    [null, "market_total_sales", "3000.0027", "17.015", 472000],
    [null, "market", "3000.0034", "17.016", false],
    [marketPriceTrendSourceId, "market_price_trend_source", "3000.0051", "17.018", "Synthetic MLS Market Dataset"],
    [null, "market_price_trend_commentary", "3000.0040", "17.019", "Monthly median sale prices from the synthetic MLS market dataset were reviewed over the 12-month period. The series indicates stable pricing with ordinary month-to-month variation and no conflicting source trend."],
    [null, "market", "3000.0033", "17.021", "InBalance"],
    [null, "market", "3000.0031", "17.022", "UnderThreeMonths"],
    [null, "market_commentary", "0100.0044", "17.023", "The synthetic subject competes in an established single-family market with balanced supply and typical marketing under three months."],
  ];
  for (const [entityId, context, uid, reportFieldId, value] of marketValues) {
    await seedEntityValue(sfrWorkfileId, entityId, context, uid, reportFieldId, value);
  }

  const projectDataSourceId = await ensureEntity(
    sfrWorkfileId,
    null,
    "project_data_source",
    "project-data-source-1",
    1,
    "Project Data Source 1",
  );
  const projectUtilityId = await ensureEntity(
    sfrWorkfileId,
    null,
    "project_utility",
    "project-utility-1",
    1,
    "Included Utility 1",
  );
  const projectAmenityId = await ensureEntity(
    sfrWorkfileId,
    null,
    "project_amenity",
    "project-amenity-1",
    1,
    "Common Amenity 1",
  );
  const projectValues = [
    [projectDataSourceId, "project_data_source", "0700.0125", "18.005", "HomeownersAssociation"],
    [projectUtilityId, "project_utility", "2500.0009", "18.013", "None"],
    [projectAmenityId, "project_amenity", "2500.0004", "18.012", "Clubhouse"],
    [null, "project_association_dues", "2500.0007", "18.011", 125],
    [null, "project_developer", "2500.0067", "18.064", false],
    [null, "project_information", "2500.0051", "18.070", false],
    [null, "project_special_assessment", "2500.0163", "18.072", "None"],
    [null, "project_tax", "2500.0081", "18.073", false],
    [null, "project_information_commentary", "2500.0170", "18.095", "The synthetic subject is in a PUD with mandatory monthly association dues and common clubhouse access."],
  ];
  for (const [entityId, context, uid, reportFieldId, value] of projectValues) {
    await seedEntityValue(sfrWorkfileId, entityId, context, uid, reportFieldId, value);
  }

  const subjectListingId = await ensureEntity(
    sfrWorkfileId,
    null,
    "subject_listing",
    "subject-listing-1",
    1,
    "Subject Listing 1",
  );
  const subjectListingValues = [
    [null, "subject_listing_summary", "0900.0004", "19.000", true],
    [subjectListingId, "subject_listing", "0900.0013", "19.002", "OffMarket"],
    [subjectListingId, "subject_listing", "0900.0015", "19.003", "MLS"],
    [subjectListingId, "subject_listing", "0900.0011", "19.004", "NTREIS-SYNTHETIC-19001"],
    [subjectListingId, "subject_listing", "0900.0012", "19.005", "2026-06-01"],
    [subjectListingId, "subject_listing", "0900.0010", "19.006", "2026-06-30"],
    [subjectListingId, "subject_listing", "0900.0007", "19.007", 30],
    [subjectListingId, "subject_listing", "0900.0009", "19.008", 449000],
    [subjectListingId, "subject_listing", "0900.0008", "19.009", 435000],
    [null, "subject_listing_summary", "0900.0003", "19.010", 30],
    [null, "subject_listing_commentary", "0900.0020", "19.011", "The synthetic subject was exposed through one MLS listing for 30 days. The final list price was reduced from $449,000 to $435,000 before the listing was withdrawn without a settled sale."],
  ];
  for (const [entityId, context, uid, reportFieldId, value] of subjectListingValues) {
    await seedEntityValue(sfrWorkfileId, entityId, context, uid, reportFieldId, value);
  }

  const areaSourceId = await ensureEntity(sfrWorkfileId, sfrUnitId, "unit_area_data_source", "unit-area-source-1", 1, "Area Source 1");
  await seedEntityValue(sfrWorkfileId, areaSourceId, "unit_area_data_source", "0700.0125", "10.009", "PhysicalMeasurement");
  const levelId = await ensureEntity(sfrWorkfileId, sfrUnitId, "unit_level", "unit-level-1", 1, "Level 1");
  await seedEntityValue(sfrWorkfileId, levelId, "unit_level", "0700.0030", "10.029", "LevelOne");
  await seedEntityValue(sfrWorkfileId, levelId, "unit_level", "0700.0029", "10.030", "AboveGrade");
  await seedEntityValue(sfrWorkfileId, levelId, "unit_level", "0700.0137", "10.032", { amount: 2100, unit: "SquareFeet" });
  await seedEntityValue(sfrWorkfileId, levelId, "unit_level", "0700.0138", "10.032", { amount: 0, unit: "SquareFeet" });

  const roomFixtures = [
    ["unit-room-bedroom-1", 1, "Bedroom 1", "Bedroom"],
    ["unit-room-bedroom-2", 2, "Bedroom 2", "Bedroom"],
    ["unit-room-bedroom-3", 3, "Bedroom 3", "Bedroom"],
    ["unit-room-full-bath-1", 4, "Full Bathroom 1", "FullBathroom"],
    ["unit-room-full-bath-2", 5, "Full Bathroom 2", "FullBathroom"],
    ["unit-room-kitchen-1", 6, "Kitchen 1", "Kitchen"],
  ];
  for (const [identifier, ordinal, label, roomType] of roomFixtures) {
    const roomId = await ensureEntity(sfrWorkfileId, sfrUnitId, "unit_room", identifier, ordinal, label);
    await seedEntityValue(sfrWorkfileId, roomId, "unit_room", "0700.0035", "10.033", roomType);
    await seedEntityValue(sfrWorkfileId, roomId, "unit_room", "0700.0121", "10.037", "LevelOne");
    if (["FullBathroom", "HalfBathroom", "Kitchen"].includes(roomType)) {
      await seedEntityValue(sfrWorkfileId, roomId, "unit_room", "0700.0036", "10.038", "NotUpdated");
      await seedEntityValue(sfrWorkfileId, roomId, "unit_room", "0700.0044", "10.040", "Typical quality for the market");
      await seedEntityValue(sfrWorkfileId, roomId, "unit_room", "0700.0033", "10.041", "TypicalWearAndTear");
    }
  }

  const flooringId = await ensureEntity(sfrWorkfileId, sfrUnitId, "unit_interior_feature", "unit-feature-flooring-1", 1, "Flooring 1");
  await seedEntityValue(sfrWorkfileId, flooringId, "unit_interior_feature", "0700.0046", "10.044", "Flooring");
  await seedEntityValue(sfrWorkfileId, flooringId, "unit_interior_feature", "0700.0041", "10.045", "Carpet");
  await seedEntityValue(sfrWorkfileId, flooringId, "unit_interior_feature", "0700.0106", "10.046", "Typical quality for the market");
  await seedEntityValue(sfrWorkfileId, flooringId, "unit_interior_feature", "0700.0104", "10.047", "TypicalWearAndTear");
  const wallsId = await ensureEntity(sfrWorkfileId, sfrUnitId, "unit_interior_feature", "unit-feature-walls-1", 2, "Walls and Ceiling 1");
  await seedEntityValue(sfrWorkfileId, wallsId, "unit_interior_feature", "0700.0046", "10.044", "WallsAndCeiling");
  await seedEntityValue(sfrWorkfileId, wallsId, "unit_interior_feature", "0700.0050", "10.044", "EightFeet");
  await seedEntityValue(sfrWorkfileId, wallsId, "unit_interior_feature", "0700.0108", "10.044", "Flat");
  await seedEntityValue(sfrWorkfileId, wallsId, "unit_interior_feature", "0700.0107", "10.044", "Typical quality for the market");
  await seedEntityValue(sfrWorkfileId, wallsId, "unit_interior_feature", "0700.0045", "10.044", "TypicalWearAndTear");

  let manufacturedWorkfileResult = await pool.query(
    `SELECT id
       FROM appraisal.uad_workfiles
      WHERE account_id = $1 AND lower(file_number) = lower($2)
      ORDER BY created_at, id
      LIMIT 1`,
    [MANUFACTURED_HOME_ACCOUNT_ID, MANUFACTURED_HOME_FILE_NUMBER],
  );
  if (!manufacturedWorkfileResult.rows.length) {
    await createUadWorkfile(pool, MANUFACTURED_HOME_ACCOUNT_ID, {
      file_number: MANUFACTURED_HOME_FILE_NUMBER,
      assignment_purpose: "Synthetic manufactured-home Section 9 staging validation",
    });
    manufacturedWorkfileResult = await pool.query(
      `SELECT id
         FROM appraisal.uad_workfiles
        WHERE account_id = $1 AND lower(file_number) = lower($2)
        ORDER BY created_at, id
        LIMIT 1`,
      [MANUFACTURED_HOME_ACCOUNT_ID, MANUFACTURED_HOME_FILE_NUMBER],
    );
  }

  const manufacturedWorkfileId = manufacturedWorkfileResult.rows[0].id;
  const manufacturedDwellingResult = await pool.query(
    `SELECT id
       FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = 'dwelling'
      ORDER BY ordinal, id
      LIMIT 1`,
    [manufacturedWorkfileId],
  );
  if (!manufacturedDwellingResult.rows.length) {
    throw new Error("manufactured-home staging workfile is missing its dwelling entity");
  }
  const manufacturedDwellingId = manufacturedDwellingResult.rows[0].id;

  await pool.query(
    `UPDATE appraisal.uad_workfiles
        SET property_type = 'manufactured_home', updated_at = now()
      WHERE id = $1`,
    [manufacturedWorkfileId],
  );
  await pool.query(
    `INSERT INTO appraisal.uad_field_values (
       id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
       source_type, source_reference, source_observed_at, is_appraiser_confirmed
     ) VALUES (
       $1, $2, $3, 'dwelling', '0300.0034', '8.011', $4::jsonb,
       'calculated', 'uad_staging_fixture.manufactured_construction', now(), false
     )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), manufacturedWorkfileId, manufacturedDwellingId, JSON.stringify("Manufactured")],
  );
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET value = $4::jsonb,
            report_field_id = '8.011',
            source_type = 'calculated',
            source_reference = 'uad_staging_fixture.manufactured_construction',
            source_observed_at = now(),
            is_appraiser_confirmed = false,
            updated_at = now()
      WHERE workfile_id = $1
        AND entity_id = $2
        AND field_context = 'dwelling'
        AND uad_uid = $3`,
    [manufacturedWorkfileId, manufacturedDwellingId, "0300.0034", JSON.stringify("Manufactured")],
  );

  console.log(JSON.stringify({
    prepared: true,
    database: databaseName,
    synthetic_account_id: SFR_ACCOUNT_ID,
    synthetic_account_ids: [SFR_ACCOUNT_ID, MANUFACTURED_HOME_ACCOUNT_ID],
    synthetic_mobile_user_id: STAGING_USER_ID,
    synthetic_mobile_user_email: STAGING_USER_EMAIL,
    site_built_workfile_id: sfrWorkfileId,
    manufactured_home_workfile_id: manufacturedWorkfileId,
  }));
} finally {
  await pool.end();
}
