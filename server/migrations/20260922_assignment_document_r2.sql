CREATE SCHEMA IF NOT EXISTS app;

ALTER TABLE app.assignment_documents ALTER COLUMN content DROP NOT NULL;
ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'postgres';
ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS storage_status text NOT NULL DEFAULT 'stored';
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_bucket text;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS object_key text;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_etag text;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_content_type text;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_verified_at timestamptz;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS storage_last_error text;
ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS next_processing_at timestamptz;
ALTER TABLE app.assignment_documents ADD COLUMN IF NOT EXISTS last_processing_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assignment_documents_storage_provider_check'
      AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_storage_provider_check
      CHECK (storage_provider IN ('postgres', 'r2'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assignment_documents_storage_status_check'
      AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_storage_status_check
      CHECK (storage_status IN ('stored', 'migration_failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assignment_documents_storage_payload_check'
      AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_storage_payload_check
      CHECK (
        (storage_provider = 'postgres' AND content IS NOT NULL)
        OR
        (
          storage_provider = 'r2'
          AND content IS NULL
          AND storage_bucket IS NOT NULL
          AND object_key IS NOT NULL
          AND storage_verified_at IS NOT NULL
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS assignment_documents_storage_migration_idx
  ON app.assignment_documents (storage_status, uploaded_at)
  WHERE storage_provider = 'postgres' AND content IS NOT NULL;

CREATE INDEX IF NOT EXISTS assignment_documents_processing_idx
  ON app.assignment_documents (processing_status, uploaded_at)
  WHERE processing_status IN ('uploaded', 'processing', 'extraction_failed');

CREATE TABLE IF NOT EXISTS app.assignment_document_candidate_reviews (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL
    REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
  candidate_id bigint,
  field_key text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text,
  review_status text NOT NULL
    CHECK (review_status IN ('confirmed', 'rejected')),
  confirmed_value text,
  reviewer text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignment_document_candidate_reviews_idx
  ON app.assignment_document_candidate_reviews (document_id, reviewed_at DESC, id DESC);
