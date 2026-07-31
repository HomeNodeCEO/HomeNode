CREATE SCHEMA IF NOT EXISTS app;

ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS data_quality_status text,
    ADD COLUMN IF NOT EXISTS data_quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS canonical_account_id text;

ALTER TABLE app.dcad_scrape_state
    ADD COLUMN IF NOT EXISTS quality_status text,
    ADD COLUMN IF NOT EXISTS quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS canonical_account_id text;

ALTER TABLE app.dcad_residential_targets
    ADD COLUMN IF NOT EXISTS source_address text,
    ADD COLUMN IF NOT EXISTS source_city text,
    ADD COLUMN IF NOT EXISTS source_postal_code text;

CREATE TABLE IF NOT EXISTS app.dcad_account_reconciliations (
    source_account_id   text PRIMARY KEY,
    canonical_account_id text,
    source_address      text,
    source_city         text,
    source_postal_code  text,
    status              text NOT NULL DEFAULT 'pending_search',
    match_method        text,
    match_confidence    numeric(5, 4),
    candidate_count     integer NOT NULL DEFAULT 0,
    attempts            integer NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    last_attempt_at     timestamptz,
    lease_expires_at    timestamptz,
    worker_id           text,
    last_error          text,
    evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dcad_account_reconciliation_status_check CHECK (
        status IN (
            'pending_search', 'leased', 'retry', 'auto_matched',
            'manual_matched', 'source_confirmed', 'needs_review', 'verified_invalid'
        )
    )
);

CREATE INDEX IF NOT EXISTS dcad_account_reconciliations_due_idx
    ON app.dcad_account_reconciliations (next_attempt_at, created_at)
    WHERE status IN ('pending_search', 'retry');

CREATE INDEX IF NOT EXISTS accounts_canonical_account_idx
    ON core.accounts (canonical_account_id)
    WHERE canonical_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_data_quality_status_idx
    ON core.accounts (data_quality_status)
    WHERE data_quality_status IS NOT NULL;
