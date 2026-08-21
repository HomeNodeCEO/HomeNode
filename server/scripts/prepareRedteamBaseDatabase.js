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
