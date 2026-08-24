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

    ALTER TABLE core.primary_improvements
      ADD COLUMN IF NOT EXISTS percent_complete numeric,
      ADD COLUMN IF NOT EXISTS effective_year_built integer,
      ADD COLUMN IF NOT EXISTS actual_age integer,
      ADD COLUMN IF NOT EXISTS depreciation numeric,
      ADD COLUMN IF NOT EXISTS desirability text,
      ADD COLUMN IF NOT EXISTS stories numeric,
      ADD COLUMN IF NOT EXISTS total_living_area integer,
      ADD COLUMN IF NOT EXISTS basement text,
      ADD COLUMN IF NOT EXISTS kitchens integer,
      ADD COLUMN IF NOT EXISTS wetbars integer,
      ADD COLUMN IF NOT EXISTS fireplaces integer,
      ADD COLUMN IF NOT EXISTS sprinkler text,
      ADD COLUMN IF NOT EXISTS spa text,
      ADD COLUMN IF NOT EXISTS pool boolean,
      ADD COLUMN IF NOT EXISTS sauna text,
      ADD COLUMN IF NOT EXISTS air_conditioning text,
      ADD COLUMN IF NOT EXISTS heating text,
      ADD COLUMN IF NOT EXISTS foundation text,
      ADD COLUMN IF NOT EXISTS roof_material text,
      ADD COLUMN IF NOT EXISTS roof_type text,
      ADD COLUMN IF NOT EXISTS exterior_material text,
      ADD COLUMN IF NOT EXISTS fence_type text,
      ADD COLUMN IF NOT EXISTS building_class text,
      ADD COLUMN IF NOT EXISTS total_area_sqft integer,
      ADD COLUMN IF NOT EXISTS baths_full integer,
      ADD COLUMN IF NOT EXISTS baths_half integer;

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
      ADD COLUMN IF NOT EXISTS state_code text,
      ADD COLUMN IF NOT EXISTS pricing_method text,
      ADD COLUMN IF NOT EXISTS unit_price numeric,
      ADD COLUMN IF NOT EXISTS market_adjustment_pct numeric,
      ADD COLUMN IF NOT EXISTS adjusted_price numeric,
      ADD COLUMN IF NOT EXISTS ag_land boolean;

    CREATE TABLE IF NOT EXISTS core.secondary_improvements (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      sec_imp_number integer,
      sec_imp_type text,
      sec_imp_sqft integer,
      sec_imp_year_built integer
    );

    ALTER TABLE core.secondary_improvements
      ADD COLUMN IF NOT EXISTS sec_imp_cons_type text,
      ADD COLUMN IF NOT EXISTS sec_imp_floor text,
      ADD COLUMN IF NOT EXISTS sec_imp_ext_wall text,
      ADD COLUMN IF NOT EXISTS sec_imp_value numeric;

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

    ALTER TABLE core.sales_source_records
      ADD COLUMN IF NOT EXISTS listing_key text,
      ADD COLUMN IF NOT EXISTS listing_id text;

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

    CREATE TABLE IF NOT EXISTS core.sales_source_media (
      id bigserial PRIMARY KEY,
      source_record_id bigint NOT NULL
        REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
      media_key text,
      media_url text NOT NULL,
      media_category text NOT NULL DEFAULT 'image',
      mime_type text,
      order_number integer,
      preferred_photo_yn boolean NOT NULL DEFAULT false,
      short_description text,
      permission text,
      modification_timestamp timestamptz,
      source_filename text NOT NULL,
      source_sha256 text NOT NULL,
      source_row_number integer NOT NULL,
      raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      loaded_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sales_source_media_url_check CHECK (media_url ~* '^https?://'),
      CONSTRAINT sales_source_media_order_check CHECK (order_number IS NULL OR order_number >= 0),
      CONSTRAINT sales_source_media_unique UNIQUE (source_record_id, media_url)
    );

    CREATE INDEX IF NOT EXISTS sales_source_media_record_order_idx
      ON core.sales_source_media (
        source_record_id,
        preferred_photo_yn DESC,
        order_number NULLS LAST,
        id
      );

    CREATE OR REPLACE VIEW core.v_sales_media_summary AS
      SELECT
        source_record_id,
        (
          array_agg(
            media_url
            ORDER BY preferred_photo_yn DESC, order_number NULLS LAST, id
          )
        )[1] AS primary_photo_url,
        count(*)::integer AS photo_count
      FROM core.sales_source_media
      WHERE media_category = 'image'
      GROUP BY source_record_id;

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
      loaded_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE core.sales
      ADD COLUMN IF NOT EXISTS loaded_at timestamptz NOT NULL DEFAULT now();

    CREATE UNIQUE INDEX IF NOT EXISTS sales_source_record_unique_idx
      ON core.sales (source_record_id)
      WHERE source_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx
      ON core.sales (account_id, closing_date DESC);

    CREATE TABLE IF NOT EXISTS core.account_housing_profiles (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      structural_style text,
      housing_type text,
      attachment_type text,
      architectural_style text,
      source_name text,
      source_url text,
      source_record_reference text,
      observed_at timestamptz,
      confidence numeric,
      notes text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE VIEW core.v_account_housing_profiles AS
      SELECT account_id, structural_style, housing_type, attachment_type,
             architectural_style, source_name, source_url,
             source_record_reference, observed_at, confidence,
             'verified_override'::text AS profile_source
      FROM core.account_housing_profiles;

    CREATE OR REPLACE VIEW core.v_sales_enriched AS
      WITH parcel_rollup AS (
        SELECT
          source_record_id,
          count(DISTINCT source_position) AS provided_parcel_fields,
          count(DISTINCT account_id) FILTER (WHERE account_id IS NOT NULL)
            AS resolved_account_count,
          jsonb_agg(
            jsonb_build_object(
              'source_position', source_position,
              'parcel_sequence', parcel_sequence,
              'parcel_role', parcel_role,
              'parcel_number_raw', parcel_number_raw,
              'parcel_number_normalized', parcel_number_normalized,
              'account_id', account_id,
              'match_method', match_method,
              'is_resolved', is_resolved
            )
            ORDER BY source_position, parcel_sequence
          ) AS linked_parcels
        FROM core.sale_parcels
        GROUP BY source_record_id
      )
      SELECT
        sale.id AS sale_id,
        source_record.id AS source_record_id,
        COALESCE(NULLIF(btrim(sale.account_id), ''), source_record.primary_account_id)
          AS primary_account_id,
        account.county,
        COALESCE(
          NULLIF(btrim(sale.address), ''),
          NULLIF(btrim(account.address), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'Address'), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'UnparsedAddress'), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'PropertyAddress'), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'StreetAddress'), '')
        ) AS address,
        COALESCE(
          NULLIF(btrim(sale.city), ''),
          NULLIF(btrim(account.city), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'City'), '')
        ) AS city,
        sale.state,
        COALESCE(
          NULLIF(btrim(sale.zip), ''),
          NULLIF(btrim(account.postal_code), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'PostalCode'), ''),
          NULLIF(btrim(source_record.raw_payload ->> 'Zip'), '')
        ) AS zip,
        COALESCE(sale.closing_date, source_record.close_date) AS closing_date,
        COALESCE(sale.sale_price, source_record.current_price) AS sale_price,
        COALESCE(sale.days_on_market, source_record.days_on_market) AS days_on_market,
        COALESCE(sale.concessions, source_record.seller_contributions::text) AS concessions,
        source_record.seller_contributions,
        source_record.listing_contract_date,
        source_record.buyer_financing,
        source_record.mls_status,
        COALESCE(source_record.source_name, sale.source) AS source,
        source_record.source_filename,
        source_record.source_files,
        source_record.source_row_number,
        source_record.source_record_hash,
        source_record.transaction_fingerprint,
        COALESCE(
          source_record.match_status,
          CASE
            WHEN NULLIF(btrim(sale.account_id), '') IS NULL THEN 'unmatched'
            ELSE 'exact'
          END
        ) AS match_status,
        COALESCE(source_record.has_multiple_parcel_numbers, false)
          AS has_multiple_parcel_numbers,
        COALESCE(source_record.multi_parcel_status, 'single') AS multi_parcel_status,
        COALESCE(
          source_record.has_unresolved_parcel,
          NULLIF(btrim(sale.account_id), '') IS NULL
        ) AS has_unresolved_parcel,
        COALESCE(
          source_record.requires_additional_review,
          NULLIF(btrim(sale.account_id), '') IS NULL
        ) AS requires_additional_review,
        COALESCE(source_record.data_quality_flags, '[]'::jsonb) AS data_quality_flags,
        COALESCE(parcel_rollup.provided_parcel_fields, 0) AS provided_parcel_fields,
        COALESCE(parcel_rollup.resolved_account_count, 0) AS resolved_account_count,
        COALESCE(parcel_rollup.linked_parcels, '[]'::jsonb) AS linked_parcels,
        source_record.bedrooms_total AS mls_bedrooms_total,
        source_record.bathrooms_total_integer AS mls_bathrooms_total_integer,
        source_record.bathrooms_full AS mls_bathrooms_full,
        source_record.bathrooms_half AS mls_bathrooms_half,
        source_record.living_area AS mls_living_area,
        source_record.lot_size_area AS mls_lot_size_area,
        source_record.year_built AS mls_year_built,
        source_record.garage_spaces AS mls_garage_spaces,
        source_record.garage_yn AS mls_garage_yn,
        source_record.pool_yn AS mls_pool_yn,
        source_record.ratio_current_price_by_living_area,
        source_record.ratio_close_price_by_list_price,
        source_record.ratio_close_price_by_original_list_price,
        source_record.ratio_close_price_by_living_area,
        improvement.bedroom_count AS cad_bedroom_count,
        improvement.bath_count AS cad_bath_count,
        improvement.baths_full AS cad_baths_full,
        improvement.baths_half AS cad_baths_half,
        improvement.living_area_sqft AS cad_living_area_sqft,
        improvement.total_area_sqft AS cad_total_area_sqft,
        improvement.year_built AS cad_year_built,
        improvement.effective_year_built AS cad_effective_year_built,
        improvement.stories AS cad_stories,
        improvement.pool AS cad_pool,
        improvement.building_class AS cad_building_class,
        value_current.land_value AS cad_land_value,
        value_current.improvement_value AS cad_improvement_value,
        value_current.market_value AS cad_market_value,
        source_record.raw_payload,
        COALESCE(source_record.loaded_at, sale.loaded_at) AS loaded_at,
        COALESCE(source_record.record_type, 'closed_sale') AS record_type,
        COALESCE(
          NULLIF(btrim(source_record.structural_style), ''),
          housing_profile.structural_style
        ) AS structural_style,
        CASE
          WHEN NULLIF(btrim(source_record.structural_style), '') IS NOT NULL
            THEN source_record.housing_type
          ELSE housing_profile.housing_type
        END AS housing_type,
        CASE
          WHEN NULLIF(btrim(source_record.structural_style), '') IS NOT NULL
            THEN COALESCE(source_record.attachment_type, 'unknown')
          ELSE COALESCE(housing_profile.attachment_type, 'unknown')
        END AS attachment_type,
        COALESCE(
          NULLIF(btrim(source_record.architectural_style), ''),
          housing_profile.architectural_style
        ) AS architectural_style
      FROM core.sales sale
      FULL OUTER JOIN core.sales_source_records source_record
        ON source_record.id = sale.source_record_id
      LEFT JOIN parcel_rollup
        ON parcel_rollup.source_record_id = source_record.id
      LEFT JOIN core.accounts account
        ON account.account_id = COALESCE(
          NULLIF(btrim(sale.account_id), ''),
          source_record.primary_account_id
        )
      LEFT JOIN core.v_account_housing_profiles housing_profile
        ON housing_profile.account_id = COALESCE(
          NULLIF(btrim(sale.account_id), ''),
          source_record.primary_account_id
        )
      LEFT JOIN core.primary_improvements improvement
        ON improvement.account_id = COALESCE(
          NULLIF(btrim(sale.account_id), ''),
          source_record.primary_account_id
        )
      LEFT JOIN core.value_summary_current value_current
        ON value_current.account_id = COALESCE(
          NULLIF(btrim(sale.account_id), ''),
          source_record.primary_account_id
        );

    CREATE TABLE IF NOT EXISTS core.owner_summary (
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      owner_name text,
      mailing_address text,
      PRIMARY KEY (account_id, tax_year)
    );

    CREATE TABLE IF NOT EXISTS core.owner_parties (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      owner_name text,
      ownership_pct numeric
    );

    CREATE INDEX IF NOT EXISTS owner_parties_account_year_idx
      ON core.owner_parties (account_id, tax_year DESC);

    CREATE TABLE IF NOT EXISTS core.legal_description_current (
      account_id text PRIMARY KEY REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer,
      legal_lines jsonb,
      legal_text text,
      deed_transfer_date date
    );

    CREATE TABLE IF NOT EXISTS core.legal_description_history (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer,
      legal_lines jsonb,
      legal_text text,
      deed_transfer_date date
    );

    CREATE INDEX IF NOT EXISTS legal_description_history_account_year_idx
      ON core.legal_description_history (account_id, tax_year DESC);

    CREATE TABLE IF NOT EXISTS core.exemptions_summary (
      id bigserial PRIMARY KEY,
      account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
      tax_year integer NOT NULL,
      jurisdiction_key text,
      taxing_jurisdiction text,
      homestead_exemption numeric,
      disabled_vet numeric,
      taxable_value numeric
    );

    CREATE INDEX IF NOT EXISTS exemptions_summary_account_year_idx
      ON core.exemptions_summary (account_id, tax_year DESC);

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
    `INSERT INTO core.account_housing_profiles (
       account_id, structural_style, housing_type, attachment_type,
       architectural_style, source_name, source_record_reference,
       observed_at, confidence, notes
     ) VALUES ($1, 'Single Family', 'Single Family Residence', 'detached',
               'Traditional', 'HomeNode synthetic red-team fixture',
               'REDTEAM-HOUSING-0001', now(), 1.000, 'Synthetic test evidence')
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
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.owner_summary (account_id, tax_year, owner_name, mailing_address)
     VALUES ($1, 2026, 'Synthetic Red Team Owner', '300 Red Team Test Dr, Garland, TX 75044')
     ON CONFLICT (account_id, tax_year) DO UPDATE SET
       owner_name = EXCLUDED.owner_name,
       mailing_address = EXCLUDED.mailing_address`,
    [fixtureAccountId],
  );
  await pool.query(
    `DELETE FROM core.owner_parties
     WHERE account_id = $1 AND tax_year = 2026`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.owner_parties (account_id, tax_year, owner_name, ownership_pct)
     VALUES ($1, 2026, 'Synthetic Red Team Owner', 100)`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.legal_description_current (
       account_id, tax_year, legal_lines, legal_text, deed_transfer_date
     ) VALUES ($1, 2026, '["LOT 1 BLOCK R RED TEAM TEST ESTATES"]'::jsonb,
               'LOT 1 BLOCK R RED TEAM TEST ESTATES', DATE '2024-06-15')
     ON CONFLICT (account_id) DO UPDATE SET
       tax_year = EXCLUDED.tax_year,
       legal_lines = EXCLUDED.legal_lines,
       legal_text = EXCLUDED.legal_text,
       deed_transfer_date = EXCLUDED.deed_transfer_date`,
    [fixtureAccountId],
  );
  await pool.query(
    `DELETE FROM core.exemptions_summary
     WHERE account_id = $1 AND tax_year = 2026 AND jurisdiction_key = 'CITY'`,
    [fixtureAccountId],
  );
  await pool.query(
    `INSERT INTO core.exemptions_summary (
       account_id, tax_year, jurisdiction_key, taxing_jurisdiction,
       homestead_exemption, disabled_vet, taxable_value
     ) VALUES ($1, 2026, 'CITY', 'Synthetic City of Garland', 0, 0, 425000)`,
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
