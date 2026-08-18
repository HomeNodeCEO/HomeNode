import "dotenv/config";
import pg from "pg";

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

    CREATE TABLE IF NOT EXISTS core.secondary_improvements (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      sec_imp_number integer,
      sec_imp_type text,
      sec_imp_sqft integer,
      sec_imp_year_built integer
    );

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
    ) VALUES (
      'UAD-STAGING-SFR-0001', 'Dallas', '100 Test Subject Dr', 'TEST SUBJECT DR',
      'Garland', '75044',
      'STG-001', 'Test Estates', 'LOT 1 BLOCK A TEST ESTATES'
    )
    ON CONFLICT (account_id) DO UPDATE SET
      street_name = EXCLUDED.street_name;

    INSERT INTO core.account_locations (
      account_id, latitude, longitude, source_site_address,
      source_neighborhood_code, source_living_area_sqft, metadata
    ) VALUES (
      'UAD-STAGING-SFR-0001', 32.9500, -96.6500, '100 Test Subject Dr',
      'STG-001', 2100, '{"source_state":"TX","synthetic":true}'::jsonb
    )
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.primary_improvements (
      account_id, year_built, living_area_sqft, bedroom_count, bath_count,
      number_units, construction_type
    ) VALUES (
      'UAD-STAGING-SFR-0001', 2005, 2100, 3, 2.5, 1, 'Frame'
    )
    ON CONFLICT (account_id) DO NOTHING;

    INSERT INTO core.land_detail (
      account_id, tax_year, line_number, zoning, frontage_ft, depth_ft, area_sqft
    ) VALUES (
      'UAD-STAGING-SFR-0001', 2026, 1, 'SF-7', 70, 120, 8400
    )
    ON CONFLICT (account_id, tax_year, line_number) DO NOTHING;

    INSERT INTO core.value_summary_current (
      account_id, certified_year, market_value, improvement_value, land_value, capped_value
    ) VALUES (
      'UAD-STAGING-SFR-0001', 2026, 425000, 350000, 75000, 410000
    )
    ON CONFLICT (account_id) DO UPDATE SET
      certified_year = EXCLUDED.certified_year,
      market_value = EXCLUDED.market_value,
      improvement_value = EXCLUDED.improvement_value,
      land_value = EXCLUDED.land_value,
      capped_value = EXCLUDED.capped_value;
  `);

  console.log(JSON.stringify({
    prepared: true,
    database: databaseName,
    synthetic_account_id: "UAD-STAGING-SFR-0001",
  }));
} finally {
  await pool.end();
}
