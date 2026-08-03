BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.sale_characteristic_reviews (
  source_record_id bigint PRIMARY KEY REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
  listing_id text,
  condition_rating text,
  quality_rating text,
  notes text,
  reviewer text NOT NULL DEFAULT 'HomeNode editor',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.sale_characteristic_review_history (
  id bigserial PRIMARY KEY,
  source_record_id bigint NOT NULL,
  listing_id text,
  condition_rating text,
  quality_rating text,
  notes text,
  reviewer text NOT NULL,
  revision integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_review_history_source_idx
  ON app.sale_characteristic_review_history (source_record_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS app.subject_appraisal_ratings (
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  condition_rating text,
  quality_rating text,
  notes text,
  reviewer text NOT NULL DEFAULT 'HomeNode editor',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, effective_date)
);

CREATE TABLE IF NOT EXISTS app.subject_appraisal_rating_history (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  effective_date date NOT NULL,
  condition_rating text,
  quality_rating text,
  notes text,
  reviewer text NOT NULL,
  revision integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subject_rating_history_account_idx
  ON app.subject_appraisal_rating_history
    (account_id, effective_date DESC, changed_at DESC);

COMMIT;

