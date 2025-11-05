-- Prepare mooolah_inc core schema for DCAD scraper data
-- Idempotent: safe to run multiple times

BEGIN;

-- Ensure core schema exists (no-op if already present)
CREATE SCHEMA IF NOT EXISTS core;

-- Raw JSON snapshots from scraper (for auditing / replay)
CREATE TABLE IF NOT EXISTS core.dcad_json_raw (
  account_id   text    NOT NULL,
  tax_year     integer NOT NULL,
  source_url   text,
  raw          jsonb   NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, tax_year)
);

-- Helpful index if querying by fetched_at (optional)
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='core' AND indexname='idx_dcad_json_raw_fetched_at'
  ) THEN
    CREATE INDEX idx_dcad_json_raw_fetched_at ON core.dcad_json_raw (fetched_at DESC);
  END IF;
END$$;

-- Ensure uniqueness on ownership_history by (account_id, observed_year)
-- (Expected to already exist; keep for completeness)
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid=t.oid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='core' AND t.relname='ownership_history' AND c.contype='u'
      AND pg_get_constraintdef(c.oid) LIKE 'UNIQUE (account_id, observed_year)'
  ) THEN
    ALTER TABLE core.ownership_history
      ADD CONSTRAINT uq_ownership_history UNIQUE (account_id, observed_year);
  END IF;
END$$;

COMMIT;

