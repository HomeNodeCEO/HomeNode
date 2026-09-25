-- Prepared, descriptive city/subdivision facts. A single indexed relation per
-- fact type scales better than creating a physical table for each city. These
-- rows are NOT assignment-authorized appraisal evidence or legal subdivision
-- boundaries. Reports must continue to read and validate original sources.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.neighborhood_group_generations (
  generation_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('building', 'complete', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  source_observed_at timestamptz NOT NULL DEFAULT now(),
  parcel_count bigint NOT NULL DEFAULT 0,
  sale_count bigint NOT NULL DEFAULT 0,
  group_count bigint NOT NULL DEFAULT 0,
  error_code text
);

CREATE TABLE app.neighborhood_group_active (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation_id uuid NOT NULL REFERENCES app.neighborhood_group_generations(generation_id),
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.neighborhood_group_parcel_facts (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_group_generations(generation_id) ON DELETE CASCADE,
  object_id bigint NOT NULL,
  account_id text NOT NULL,
  county_key text,
  city_key text,
  subdivision_key text,
  recorded_subdivision text,
  label_conflict boolean NOT NULL DEFAULT false,
  living_area_sqft numeric,
  year_built integer,
  site_area_sqft numeric,
  current_market_value numeric,
  source_record_hash text,
  source_updated_at timestamptz,
  PRIMARY KEY (generation_id, object_id)
);
CREATE INDEX neighborhood_group_parcel_lookup_idx
  ON app.neighborhood_group_parcel_facts
  (generation_id, county_key, city_key, subdivision_key, account_id)
  WHERE subdivision_key IS NOT NULL;
CREATE INDEX neighborhood_group_parcel_account_idx
  ON app.neighborhood_group_parcel_facts (generation_id, account_id);

CREATE TABLE app.neighborhood_group_sale_facts (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_group_generations(generation_id) ON DELETE CASCADE,
  sale_id bigint NOT NULL,
  account_id text NOT NULL,
  county_key text,
  city_key text,
  subdivision_key text,
  closing_date date,
  sale_price numeric,
  days_on_market integer,
  source_record_id bigint,
  PRIMARY KEY (generation_id, sale_id)
);
CREATE INDEX neighborhood_group_sale_period_idx
  ON app.neighborhood_group_sale_facts
  (generation_id, county_key, city_key, subdivision_key, closing_date, sale_id)
  WHERE subdivision_key IS NOT NULL;
CREATE INDEX neighborhood_group_sale_account_idx
  ON app.neighborhood_group_sale_facts (generation_id, account_id);

-- A current, citywide overview. Its all-available-sales median is descriptive,
-- not an appraisal-period statistic. For a report date/radius/selected groups,
-- query indexed facts with that exact filter; never combine subgroup medians.
CREATE TABLE app.neighborhood_group_summary (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_group_generations(generation_id) ON DELETE CASCADE,
  county_key text NOT NULL,
  city_key text NOT NULL,
  subdivision_key text NOT NULL,
  parcel_count bigint NOT NULL,
  account_count bigint NOT NULL,
  living_area_count bigint NOT NULL,
  median_living_area_sqft double precision,
  year_built_count bigint NOT NULL,
  median_year_built double precision,
  site_area_count bigint NOT NULL,
  median_site_area_sqft double precision,
  market_value_count bigint NOT NULL,
  median_current_market_value double precision,
  sale_count bigint NOT NULL DEFAULT 0,
  median_sale_price double precision,
  first_sale_date date,
  last_sale_date date,
  PRIMARY KEY (generation_id, county_key, city_key, subdivision_key)
);
CREATE INDEX neighborhood_group_summary_city_idx
  ON app.neighborhood_group_summary
  (generation_id, county_key, city_key, account_count DESC);
