ALTER TABLE app.dcad_scrape_state
    ADD COLUMN IF NOT EXISTS failure_fingerprint text,
    ADD COLUMN IF NOT EXISTS consecutive_deterministic_failures integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS manual_review_at timestamptz,
    ADD COLUMN IF NOT EXISTS manual_review_reason text;

ALTER TABLE app.dcad_scrape_state
    DROP CONSTRAINT IF EXISTS dcad_scrape_state_deterministic_failure_count_check;

ALTER TABLE app.dcad_scrape_state
    ADD CONSTRAINT dcad_scrape_state_deterministic_failure_count_check
        CHECK (consecutive_deterministic_failures >= 0);

CREATE INDEX IF NOT EXISTS dcad_scrape_state_manual_review_idx
    ON app.dcad_scrape_state (manual_review_at, account_id)
    WHERE status = 'manual_review';
