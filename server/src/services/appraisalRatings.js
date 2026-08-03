export async function ensureAppraisalRatingsSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.sale_characteristic_reviews (
      source_record_id bigint PRIMARY KEY
        REFERENCES core.sales_source_records(id) ON DELETE CASCADE,
      listing_id text,
      condition_rating text,
      quality_rating text,
      notes text,
      reviewer text NOT NULL DEFAULT 'HomeNode editor',
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sale_review_condition_valid CHECK (
        condition_rating IS NULL OR condition_rating IN
          ('C1','C2-C1','C2','C3-C2','C3','C4-C3','C4','C5-C4','C5','C6-C5','C6')
      ),
      CONSTRAINT sale_review_quality_valid CHECK (
        quality_rating IS NULL OR quality_rating IN
          ('Q1','Q2-Q1','Q2','Q3-Q2','Q3','Q4-Q3','Q4','Q5-Q4','Q5','Q6-Q5','Q6')
      )
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
      PRIMARY KEY (account_id, effective_date),
      CONSTRAINT subject_rating_condition_valid CHECK (
        condition_rating IS NULL OR condition_rating IN
          ('C1','C2-C1','C2','C3-C2','C3','C4-C3','C4','C5-C4','C5','C6-C5','C6')
      ),
      CONSTRAINT subject_rating_quality_valid CHECK (
        quality_rating IS NULL OR quality_rating IN
          ('Q1','Q2-Q1','Q2','Q3-Q2','Q3','Q4-Q3','Q4','Q5-Q4','Q5','Q6-Q5','Q6')
      )
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
  `);
}

export const SALE_REVIEW_SELECT = `
  SELECT source_record_id, listing_id, condition_rating, quality_rating,
         notes, reviewer, revision, created_at, updated_at
  FROM app.sale_characteristic_reviews
`;

export const SUBJECT_RATING_SELECT = `
  SELECT account_id, effective_date, condition_rating, quality_rating,
         notes, reviewer, revision, created_at, updated_at
  FROM app.subject_appraisal_ratings
`;

