import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createUadWorkfile } from "../src/modules/uad/workfiles.js";

const SFR_ACCOUNT_ID = "UAD-STAGING-SFR-0001";
const MANUFACTURED_HOME_ACCOUNT_ID = "UAD-STAGING-MH-0001";
const MANUFACTURED_HOME_FILE_NUMBER = "HN-UAD-STAGING-MH-0001";

if (process.env.NODE_ENV !== "staging") {
  throw new Error("prepareUadStagingDatabase may only run with NODE_ENV=staging");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  const databaseName = String(identity.rows[0]?.database_name || "");
  if (!databaseName.toLowerCase().includes("staging")) {
    throw new Error("staging bootstrap refused a non-staging database");
  }

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
    manufactured_home_workfile_id: manufacturedWorkfileId,
  }));
} finally {
  await pool.end();
}
