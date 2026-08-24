import "dotenv/config";
import pg from "pg";

import {
  assertRedTeamDatabaseName,
  assertRedTeamFixtureAccountId,
  createRedTeamIsolationConfiguration,
  verifyRedTeamSyntheticBoundary,
} from "../src/security/redTeamIsolation.js";

const isolation = createRedTeamIsolationConfiguration();
if (!isolation.enabled || !isolation.ready) throw new Error("redteam_isolation_not_enabled");
const fixtureAccountId = assertRedTeamFixtureAccountId(
  process.env.REDTEAM_FIXTURE_ACCOUNT_ID || "UAD-REDTEAM-SFR-0001",
);

const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL || "");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  application_name: "homenode-redteam-base",
});

try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  assertRedTeamDatabaseName(identity.rows[0]?.database_name);
  await verifyRedTeamSyntheticBoundary(pool);

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
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

    CREATE TABLE IF NOT EXISTS core.account_locations (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      latitude double precision,
      longitude double precision,
      source_site_address text,
      source_neighborhood_code text,
      source_living_area_sqft integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'matched',
      attempted_at timestamptz,
      resolved_at timestamptz,
      failure_reason text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE core.account_locations
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'redteam_fixture',
      ADD COLUMN IF NOT EXISTS precision text,
      ADD COLUMN IF NOT EXISTS confidence text,
      ADD COLUMN IF NOT EXISTS match_method text,
      ADD COLUMN IF NOT EXISTS source_parcel_id text,
      ADD COLUMN IF NOT EXISTS source_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS geocoded_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS feature_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS review_reason text;

    CREATE INDEX IF NOT EXISTS account_locations_coordinate_idx
      ON core.account_locations(latitude, longitude)
      WHERE status = 'matched';
    CREATE INDEX IF NOT EXISTS account_locations_geocoded_at_idx
      ON core.account_locations(geocoded_at);

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

    -- Empty shared sales relations allow the custom/UAD comparable, rating,
    -- reconciliation, and market-analysis services to initialize without
    -- copying any MLS or production sale into the red-team boundary.
    CREATE TABLE IF NOT EXISTS core.sales_source_records (
      id bigserial PRIMARY KEY,
      source_name text NOT NULL,
      source_filename text NOT NULL,
      source_files text[] NOT NULL DEFAULT ARRAY[]::text[],
      source_sha256 text NOT NULL,
      source_row_number integer NOT NULL,
      source_record_hash text NOT NULL,
      transaction_fingerprint text NOT NULL,
      bedrooms_total integer,
      bathrooms_total_integer integer,
      bathrooms_full integer,
      bathrooms_half integer,
      living_area numeric,
      lot_size_area numeric,
      current_price numeric,
      ratio_current_price_by_living_area numeric,
      ratio_close_price_by_list_price numeric,
      ratio_close_price_by_original_list_price numeric,
      ratio_close_price_by_living_area numeric,
      days_on_market integer,
      year_built integer,
      close_date date,
      seller_contributions numeric,
      mls_status text,
      record_type text NOT NULL DEFAULT 'closed_sale',
      structural_style text,
      housing_type text,
      attachment_type text NOT NULL DEFAULT 'unknown',
      architectural_style text,
      garage_spaces numeric,
      garage_yn boolean,
      pool_yn boolean,
      listing_contract_date date,
      parcel_number_raw text,
      parcel_number2_raw text,
      buyer_financing text,
      primary_account_id text REFERENCES core.accounts(account_id),
      match_status text NOT NULL,
      has_multiple_parcel_numbers boolean NOT NULL DEFAULT false,
      multi_parcel_status text NOT NULL DEFAULT 'single',
      has_unresolved_parcel boolean NOT NULL DEFAULT false,
      requires_additional_review boolean NOT NULL DEFAULT false,
      data_quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
      raw_payload jsonb NOT NULL,
      loaded_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sales_source_records_hash_unique UNIQUE (source_record_hash),
      CONSTRAINT sales_source_records_source_row_unique UNIQUE (source_sha256, source_row_number),
      CONSTRAINT sales_source_records_match_status_check CHECK (
        match_status IN (
          'exact', 'normalized', 'secondary', 'multiple', 'unmatched',
          'address', 'manual_verified'
        )
      ),
      CONSTRAINT sales_source_records_multi_status_check CHECK (
        multi_parcel_status IN ('single', 'possible', 'confirmed')
      ),
      CONSTRAINT sales_source_records_record_type_check CHECK (
        record_type IN ('closed_sale', 'listing')
      ),
      CONSTRAINT sales_source_records_attachment_type_check CHECK (
        attachment_type IN ('detached', 'attached', 'mixed', 'unknown')
      ),
      CONSTRAINT sales_source_records_flags_array_check CHECK (
        jsonb_typeof(data_quality_flags) = 'array'
      )
    );

    CREATE INDEX IF NOT EXISTS sales_source_records_primary_account_idx
      ON core.sales_source_records (primary_account_id);
    CREATE INDEX IF NOT EXISTS sales_source_records_close_date_idx
      ON core.sales_source_records (close_date DESC);
    CREATE INDEX IF NOT EXISTS sales_source_records_fingerprint_idx
      ON core.sales_source_records (transaction_fingerprint);
    CREATE INDEX IF NOT EXISTS sales_source_records_review_idx
      ON core.sales_source_records (requires_additional_review, close_date DESC);
    CREATE INDEX IF NOT EXISTS sales_source_records_record_type_idx
      ON core.sales_source_records (
        record_type,
        COALESCE(close_date, listing_contract_date) DESC
      );

    CREATE TABLE IF NOT EXISTS core.sale_parcels (
      id bigserial PRIMARY KEY,
      source_record_id bigint NOT NULL
        REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
      source_position smallint NOT NULL,
      parcel_sequence smallint NOT NULL DEFAULT 1,
      parcel_role text NOT NULL,
      parcel_number_raw text NOT NULL,
      parcel_number_normalized text,
      account_id text REFERENCES core.accounts(account_id),
      match_method text NOT NULL,
      is_resolved boolean NOT NULL,
      loaded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sale_parcels_source_position_check CHECK (source_position IN (1, 2)),
      CONSTRAINT sale_parcels_sequence_check CHECK (parcel_sequence > 0),
      CONSTRAINT sale_parcels_role_check CHECK (parcel_role IN ('primary', 'additional')),
      CONSTRAINT sale_parcels_match_method_check CHECK (
        match_method IN (
          'exact', 'punctuation_normalized', 'embedded_full_id',
          'concatenated_full_ids', 'unmatched', 'manual_verified'
        )
      ),
      CONSTRAINT sale_parcels_source_unique
        UNIQUE (source_record_id, source_position, parcel_sequence)
    );

    CREATE INDEX IF NOT EXISTS sale_parcels_account_idx
      ON core.sale_parcels (account_id, source_record_id);
    CREATE INDEX IF NOT EXISTS sale_parcels_unresolved_idx
      ON core.sale_parcels (source_record_id)
      WHERE NOT is_resolved;

    CREATE TABLE IF NOT EXISTS core.sales (
      id bigserial PRIMARY KEY,
      account_id text REFERENCES core.accounts(account_id),
      address text,
      city text,
      state text,
      zip text,
      closing_date date,
      sale_price numeric,
      days_on_market integer,
      concessions text,
      source text,
      source_record_id bigint REFERENCES core.sales_source_records(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS sales_source_record_unique_idx
      ON core.sales (source_record_id)
      WHERE source_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx
      ON core.sales (account_id, closing_date DESC);

    CREATE TABLE IF NOT EXISTS app.county_account_identifiers (
      county text NOT NULL,
      normalized_account_id text NOT NULL,
      native_account_id text NOT NULL,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      verification_source text NOT NULL DEFAULT 'redteam_fixture',
      source_record_id bigint,
      reviewer text,
      verified_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (county, normalized_account_id)
    );
  `);

  await pool.query(
    `INSERT INTO core.accounts (
       account_id, county, address, street_name, city, postal_code,
       neighborhood_code, subdivision, legal_description, data_quality_status
     ) VALUES ($1, 'Dallas', '300 Red Team Test Dr', 'RED TEAM TEST DR',
               'Garland', '75044', 'RT-001', 'Red Team Test Estates',
               'LOT 1 BLOCK R RED TEAM TEST ESTATES', 'synthetic')
     ON CONFLICT (account_id) DO UPDATE SET
       county = EXCLUDED.county,
       address = EXCLUDED.address,
       street_name = EXCLUDED.street_name,
       city = EXCLUDED.city,
       postal_code = EXCLUDED.postal_code,
       neighborhood_code = EXCLUDED.neighborhood_code,
       subdivision = EXCLUDED.subdivision,
       legal_description = EXCLUDED.legal_description,
       data_quality_status = EXCLUDED.data_quality_status,
       updated_at = now()`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.account_locations (
       account_id, latitude, longitude, source_site_address,
       source_neighborhood_code, source_living_area_sqft, metadata, status, resolved_at
     ) VALUES ($1, 32.9500, -96.6500, '300 Red Team Test Dr', 'RT-001', 2100,
               '{"synthetic":true,"environment":"redteam","fixture_type":"site_built_sfr"}'::jsonb,
               'matched', now())
     ON CONFLICT (account_id) DO UPDATE SET
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       source_site_address = EXCLUDED.source_site_address,
       source_neighborhood_code = EXCLUDED.source_neighborhood_code,
       source_living_area_sqft = EXCLUDED.source_living_area_sqft,
       metadata = EXCLUDED.metadata,
       status = EXCLUDED.status,
       resolved_at = EXCLUDED.resolved_at,
       updated_at = now()`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.primary_improvements (
       account_id, year_built, living_area_sqft, bedroom_count, bath_count,
       number_units, construction_type
     ) VALUES ($1, 2005, 2100, 3, 2.5, 1, 'Frame')
     ON CONFLICT (account_id) DO UPDATE SET
       year_built = EXCLUDED.year_built,
       living_area_sqft = EXCLUDED.living_area_sqft,
       bedroom_count = EXCLUDED.bedroom_count,
       bath_count = EXCLUDED.bath_count,
       number_units = EXCLUDED.number_units,
       construction_type = EXCLUDED.construction_type`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.land_detail (
       account_id, tax_year, line_number, zoning, frontage_ft, depth_ft, area_sqft
     ) VALUES ($1, 2026, 1, 'SF-7', 70, 120, 8400)
     ON CONFLICT (account_id, tax_year, line_number) DO UPDATE SET
       zoning = EXCLUDED.zoning,
       frontage_ft = EXCLUDED.frontage_ft,
       depth_ft = EXCLUDED.depth_ft,
       area_sqft = EXCLUDED.area_sqft`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.value_summary_current (
       account_id, certified_year, market_value, improvement_value, land_value, capped_value
     ) VALUES ($1, 2026, 425000, 350000, 75000, 410000)
     ON CONFLICT (account_id) DO UPDATE SET
       certified_year = EXCLUDED.certified_year,
       market_value = EXCLUDED.market_value,
       improvement_value = EXCLUDED.improvement_value,
       land_value = EXCLUDED.land_value,
       capped_value = EXCLUDED.capped_value`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.market_values (
       account_id, tax_year, total_value, imp_value, land_value, homestead_cap_value
     ) VALUES ($1, 2026, 425000, 350000, 75000, 410000)
     ON CONFLICT (account_id, tax_year) DO UPDATE SET
       total_value = EXCLUDED.total_value,
       imp_value = EXCLUDED.imp_value,
       land_value = EXCLUDED.land_value,
       homestead_cap_value = EXCLUDED.homestead_cap_value`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO app.county_account_identifiers (
       county, normalized_account_id, native_account_id, account_id, verification_source
     ) VALUES ('Dallas', $1, $1, $1, 'redteam_fixture')
     ON CONFLICT (county, normalized_account_id) DO UPDATE SET
       native_account_id = EXCLUDED.native_account_id,
       account_id = EXCLUDED.account_id,
       verification_source = EXCLUDED.verification_source,
       updated_at = now()`,
    [fixtureAccountId],
  );

  console.log(JSON.stringify({
    prepared: true,
    environment: "redteam",
    synthetic_only: true,
    fixture_account_id: fixtureAccountId,
  }));
} finally {
  await pool.end();
}
