// Shared synthetic projection schema; not production ingestion/migration coverage.
export const NEIGHBORHOOD_CACHED_SOURCE_SCHEMA=`
  CREATE SCHEMA gis;
  CREATE TABLE gis.source_sync_runs(id uuid PRIMARY KEY,source_key text,mode text,status text,
    records_seen bigint,records_written bigint,records_deleted bigint,started_at timestamptz,completed_at timestamptz);
  CREATE TABLE gis.source_sync_state(source_key text PRIMARY KEY,status text,source_vintage text,row_count bigint,
    last_attempt_at timestamptz,last_success_at timestamptz,last_source_update_at timestamptz,last_run_id uuid,updated_at timestamptz);
  CREATE TABLE gis.dcad_parcels(object_id bigint PRIMARY KEY,account_id text,low_parcel_id text,
    residential_year_built integer,residential_area_sqft numeric,parcel_area_sqft numeric,current_market_value numeric,
    land_use_category text,classification_confidence text,classification_review_reason text,subdivision_name text,
    source_record_hash text,source_updated_at timestamptz,sync_run_id uuid,synced_at timestamptz,geom geometry(MultiPolygon,4326));
  CREATE INDEX cache_fixture_parcel_account_idx ON gis.dcad_parcels(account_id);
  CREATE TABLE core.sales_source_records(id bigint PRIMARY KEY,source_name text,source_filename text,
    source_sha256 text,source_record_hash text,transaction_fingerprint text,listing_key text,listing_id text,
    source_system_name text,source_modified_at timestamptz,loaded_at timestamptz,updated_at timestamptz,
    primary_account_id text,record_type text,close_date date,listing_contract_date date,current_price numeric,
    living_area numeric,lot_size_area numeric,year_built integer,bedrooms_total integer,
    bathrooms_total_integer integer,bathrooms_full integer,bathrooms_half integer,
    structural_style text,housing_type text,attachment_type text,architectural_style text,
    garage_spaces numeric,garage_yn boolean,pool_yn boolean,days_on_market integer,
    parcel_number_raw text,parcel_number2_raw text,match_status text,has_multiple_parcel_numbers boolean,
    multi_parcel_status text,has_unresolved_parcel boolean,requires_additional_review boolean,data_quality_flags jsonb,
    mls_status text,source_row_number integer,raw_payload jsonb);
  CREATE INDEX cache_fixture_source_account_idx ON core.sales_source_records(primary_account_id);
  CREATE TABLE core.sales(id bigint PRIMARY KEY,source_record_id bigint UNIQUE,account_id text,closing_date date,
    sale_price numeric,source text,loaded_at timestamptz);
  CREATE INDEX cache_fixture_sale_account_idx ON core.sales(account_id);
  CREATE TABLE core.sale_parcels(id bigint PRIMARY KEY,source_record_id bigint,source_position smallint,
    parcel_sequence smallint,parcel_role text,parcel_number_raw text,parcel_number_normalized text,account_id text,
    match_method text,is_resolved boolean,loaded_at timestamptz,UNIQUE(source_record_id,source_position,parcel_sequence));
  CREATE INDEX cache_fixture_link_account_idx ON core.sale_parcels(account_id,source_record_id);
`;
