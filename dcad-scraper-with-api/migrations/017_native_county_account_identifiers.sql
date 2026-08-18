CREATE SCHEMA IF NOT EXISTS app;

ALTER TABLE app.sales_reconciliation_history
    ADD COLUMN IF NOT EXISTS verified_parcel_id text,
    ADD COLUMN IF NOT EXISTS verified_county text;

UPDATE app.sales_reconciliation_history
SET verified_parcel_id = verified_account_id
WHERE verified_parcel_id IS NULL;

ALTER TABLE app.sales_reconciliation_history
    ALTER COLUMN verified_parcel_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS app.county_account_identifiers (
    county                  text NOT NULL,
    normalized_account_id   text NOT NULL,
    native_account_id       text NOT NULL,
    account_id              text NOT NULL
                              REFERENCES core.accounts(account_id)
                              ON DELETE CASCADE,
    verification_source     text NOT NULL DEFAULT 'manual_sales_reconciliation',
    source_record_id        bigint
                              REFERENCES core.sales_source_records(id)
                              ON DELETE SET NULL,
    reviewer                text,
    verified_at             timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (county, normalized_account_id)
);

CREATE INDEX IF NOT EXISTS county_account_identifiers_account_idx
    ON app.county_account_identifiers (account_id, county);

COMMENT ON TABLE app.county_account_identifiers IS
    'Maps authoritative county-native parcel identifiers to stable HomeNode account keys. Collin geoIDs retain their leading R and official punctuation while normalized_account_id supports punctuation-insensitive MLS matching.';
