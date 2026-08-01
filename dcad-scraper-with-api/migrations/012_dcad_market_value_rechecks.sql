ALTER TABLE app.dcad_scrape_state
    ADD COLUMN IF NOT EXISTS market_value_status text,
    ADD COLUMN IF NOT EXISTS market_value_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS market_value_missing_since timestamptz,
    ADD COLUMN IF NOT EXISTS market_value_last_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS market_value_next_check_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dcad_scrape_state_market_value_status_check'
          AND conrelid = 'app.dcad_scrape_state'::regclass
    ) THEN
        ALTER TABLE app.dcad_scrape_state
            ADD CONSTRAINT dcad_scrape_state_market_value_status_check
            CHECK (
                market_value_status IS NULL
                OR market_value_status IN ('present', 'pending', 'leased', 'retry')
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS dcad_scrape_state_market_value_due_idx
    ON app.dcad_scrape_state (market_value_next_check_at, account_id)
    WHERE market_value_status IN ('pending', 'retry');

UPDATE app.dcad_scrape_state s
SET market_value_status = 'present',
    market_value_attempts = 0,
    market_value_missing_since = NULL,
    market_value_last_checked_at = COALESCE(s.last_success_at, now()),
    market_value_next_check_at = NULL
WHERE s.status = 'succeeded'
  AND EXISTS (
      SELECT 1
      FROM core.value_summary_current v
      WHERE v.account_id = s.account_id
        AND v.market_value IS NOT NULL
  )
  AND s.market_value_status IS NULL;

-- A missing value can be legitimate during an active protest, so these rows
-- enter a low-frequency recovery lane without blocking the main campaign.
UPDATE app.dcad_scrape_state s
SET market_value_status = 'pending',
    market_value_missing_since = COALESCE(s.last_success_at, now()),
    market_value_last_checked_at = s.last_success_at,
    market_value_next_check_at = now(),
    quality_status = 'complete_missing_market_value',
    quality_flags = CASE
        WHEN 'missing_market_value' = ANY(s.quality_flags)
            THEN s.quality_flags
        ELSE array_append(s.quality_flags, 'missing_market_value')
    END
WHERE s.status = 'succeeded'
  AND EXISTS (
      SELECT 1
      FROM app.dcad_residential_targets t
      WHERE t.account_id = s.account_id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM core.value_summary_current v
      WHERE v.account_id = s.account_id
        AND v.market_value IS NOT NULL
  )
  AND s.market_value_status IS NULL;

UPDATE core.accounts a
SET data_quality_status = 'complete_missing_market_value',
    data_quality_flags = CASE
        WHEN 'missing_market_value' = ANY(a.data_quality_flags)
            THEN a.data_quality_flags
        ELSE array_append(a.data_quality_flags, 'missing_market_value')
    END
WHERE EXISTS (
    SELECT 1
    FROM app.dcad_scrape_state s
    WHERE s.account_id = a.account_id
      AND s.market_value_status IN ('pending', 'retry', 'leased')
);
