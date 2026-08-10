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
  source_latitude     double precision NOT NULL,
  source_longitude    double precision NOT NULL,
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
  CHECK (source_latitude BETWEEN -90 AND 90),
  CHECK (source_longitude BETWEEN -180 AND 180),
  CHECK (tract_geoid IS NULL OR tract_geoid ~ '^[0-9]{11}$'),
  CHECK (tract_code IS NULL OR tract_code ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS account_census_geographies_work_idx
  ON core.account_census_geographies (status, next_attempt_at, updated_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS account_census_geographies_tract_idx
  ON core.account_census_geographies (tract_geoid)
  WHERE status IN ('matched', 'review_required');

COMMIT;
