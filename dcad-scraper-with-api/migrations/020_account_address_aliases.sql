BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.account_address_aliases (
    account_id          text NOT NULL
                            REFERENCES core.accounts(account_id)
                            ON DELETE CASCADE,
    address_key         text NOT NULL,
    city_key            text NOT NULL,
    county_key          text,
    postal_code5        text,
    raw_address         text,
    raw_city            text,
    source_type         text NOT NULL DEFAULT 'core_accounts',
    source_priority     smallint NOT NULL DEFAULT 100,
    is_current          boolean NOT NULL DEFAULT true,
    source_observed_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, address_key, city_key, source_type)
);

CREATE INDEX IF NOT EXISTS account_address_aliases_lookup_idx
    ON app.account_address_aliases (
        address_key, city_key, county_key, postal_code5, account_id
    )
    WHERE is_current = true;

CREATE INDEX IF NOT EXISTS account_address_aliases_account_idx
    ON app.account_address_aliases (account_id, is_current, source_priority DESC);

CREATE TABLE IF NOT EXISTS app.account_address_alias_seed_state (
    source_type         text PRIMARY KEY,
    last_account_id     text,
    cycle_started_at    timestamptz NOT NULL DEFAULT now(),
    cycle_completed_at  timestamptz,
    next_refresh_at     timestamptz,
    rows_scanned        bigint NOT NULL DEFAULT 0,
    aliases_written     bigint NOT NULL DEFAULT 0,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMIT;

