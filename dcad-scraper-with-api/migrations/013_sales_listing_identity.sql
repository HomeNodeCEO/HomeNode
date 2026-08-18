-- MLS numbers remain stable while a listing moves from Active to Closed.
CREATE UNIQUE INDEX IF NOT EXISTS sales_source_records_listing_id_unique_idx
    ON core.sales_source_records (listing_id)
    WHERE listing_id IS NOT NULL AND btrim(listing_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS sales_source_records_listing_key_unique_idx
    ON core.sales_source_records (listing_key)
    WHERE listing_key IS NOT NULL AND btrim(listing_key) <> '';
