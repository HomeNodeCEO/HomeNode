-- Trestle/RESO identifies Property records by ListingKey. ListingId is a
-- human-facing MLS number and is not guaranteed unique across source systems.
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

