BEGIN;

ALTER TABLE core.sale_parcels
    DROP CONSTRAINT IF EXISTS sale_parcels_match_method_check;
ALTER TABLE core.sale_parcels
    ADD CONSTRAINT sale_parcels_match_method_check
    CHECK (match_method IN (
        'exact', 'punctuation_normalized', 'embedded_full_id',
        'concatenated_full_ids', 'unmatched', 'address_fallback',
        'manual_verified'
    ));

CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history (
    id                  bigserial PRIMARY KEY,
    source_record_id    bigint NOT NULL
                            REFERENCES core.sales_source_records(id)
                            ON DELETE CASCADE,
    account_id          text NOT NULL
                            REFERENCES core.accounts(account_id),
    resolution_method   text NOT NULL CHECK (
                            resolution_method IN (
                                'trusted_existing_link',
                                'unique_exact_address'
                            )
                        ),
    address_key         text,
    city_key            text,
    previous_match_status text,
    raw_parcel_number   text,
    resolved_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_record_id, resolution_method)
);

CREATE INDEX IF NOT EXISTS sales_auto_reconciliation_history_resolved_idx
    ON app.sales_auto_reconciliation_history (resolved_at DESC);

COMMIT;
