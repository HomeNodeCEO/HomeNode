BEGIN;

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.account_census_geographies (
  account_id          varchar(32) PRIMARY KEY
                      REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  tract_geoid         varchar(11),
  tract_code          varchar(6),
  state_fips          varchar(2),
  county_fips         varchar(3),
  block_code          varchar(4),
  benchmark           text NOT NULL DEFAULT 'Public_AR_Current',
  vintage             text NOT NULL DEFAULT 'Current_Current',
  source_latitude     double precision,
  source_longitude    double precision,
  source_address      text,
  source_city         text,
  source_state        text,
  source_postal_code  text,
  source_method       text NOT NULL DEFAULT 'coordinate'
                      CHECK (source_method IN ('coordinate', 'address')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending', 'processing', 'retry', 'matched',
                        'review_required', 'failed'
                      )),
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  leased_at           timestamptz,
  worker_id           text,
  response_status     text,
  review_reason       text,
  looked_up_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (source_latitude IS NULL OR source_latitude BETWEEN -90 AND 90),
  CHECK (source_longitude IS NULL OR source_longitude BETWEEN -180 AND 180),
  CHECK (tract_geoid IS NULL OR tract_geoid ~ '^[0-9]{11}$'),
  CHECK (tract_code IS NULL OR tract_code ~ '^[0-9]{6}$')
);

ALTER TABLE core.account_census_geographies
  ALTER COLUMN source_latitude DROP NOT NULL,
  ALTER COLUMN source_longitude DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_address text,
  ADD COLUMN IF NOT EXISTS source_city text,
  ADD COLUMN IF NOT EXISTS source_state text,
  ADD COLUMN IF NOT EXISTS source_postal_code text,
  ADD COLUMN IF NOT EXISTS source_method text NOT NULL DEFAULT 'coordinate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'account_census_geographies_source_method_check'
      AND conrelid = 'core.account_census_geographies'::regclass
  ) THEN
    ALTER TABLE core.account_census_geographies
      ADD CONSTRAINT account_census_geographies_source_method_check
      CHECK (source_method IN ('coordinate', 'address'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS account_census_geographies_work_idx
  ON core.account_census_geographies (status, next_attempt_at, updated_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS account_census_geographies_tract_idx
  ON core.account_census_geographies (tract_geoid)
  WHERE status IN ('matched', 'review_required');

COMMIT;
