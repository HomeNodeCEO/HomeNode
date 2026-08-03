BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

ALTER TABLE core.sales_source_records
    DROP CONSTRAINT IF EXISTS sales_source_records_match_status_check;
ALTER TABLE core.sales_source_records
    ADD CONSTRAINT sales_source_records_match_status_check
    CHECK (match_status IN (
        'exact', 'normalized', 'secondary', 'multiple', 'unmatched',
        'manual_verified'
    ));

ALTER TABLE core.sale_parcels
    DROP CONSTRAINT IF EXISTS sale_parcels_match_method_check;
ALTER TABLE core.sale_parcels
    ADD CONSTRAINT sale_parcels_match_method_check
    CHECK (match_method IN (
        'exact', 'punctuation_normalized', 'embedded_full_id',
        'concatenated_full_ids', 'unmatched', 'manual_verified'
    ));

CREATE TABLE IF NOT EXISTS app.sales_reconciliation_history (
    id                  bigserial PRIMARY KEY,
    source_record_id    bigint NOT NULL
                            REFERENCES core.sales_source_records(id)
                            ON DELETE CASCADE,
    listing_id          text,
    previous_account_id text,
    verified_account_id text NOT NULL REFERENCES core.accounts(account_id),
    notes               text,
    reviewer            text NOT NULL DEFAULT 'HomeNode editor',
    verified_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_reconciliation_history_source_idx
    ON app.sales_reconciliation_history (source_record_id, verified_at DESC);

COMMIT;
