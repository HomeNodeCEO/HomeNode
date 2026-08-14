CREATE SCHEMA IF NOT EXISTS app;

-- The application also creates these tables defensively at startup. This file
-- exists so managed production migrations can establish the same durable
-- document, page-text, and candidate-review model before the API is deployed.
CREATE TABLE IF NOT EXISTS app.assignment_documents (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE SET NULL,
  document_type text NOT NULL DEFAULT 'other'
    CHECK (document_type IN (
      'zoning_map', 'zoning_ordinance', 'purchase_contract',
      'engagement_letter', 'mls_sheet', 'map', 'other'
    )),
  title text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/pdf',
  content bytea NOT NULL,
  checksum_sha256 text NOT NULL,
  file_size_bytes bigint NOT NULL,
  page_count integer,
  processing_status text NOT NULL DEFAULT 'uploaded'
    CHECK (processing_status IN (
      'uploaded', 'processing', 'review_required', 'ocr_required',
      'extraction_failed', 'reviewed'
    )),
  extraction_method text,
  extraction_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_kind text NOT NULL DEFAULT 'upload'
    CHECK (source_kind IN ('upload', 'official_url', 'zoning_cache')),
  source_url text,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assignment_documents_scope_checksum_uidx
  ON app.assignment_documents (account_id, COALESCE(assignment_file_id, 0), checksum_sha256);
CREATE INDEX IF NOT EXISTS assignment_documents_account_idx
  ON app.assignment_documents (account_id, assignment_file_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS app.assignment_document_pages (
  document_id bigint NOT NULL REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  extracted_text text NOT NULL DEFAULT '',
  text_length integer NOT NULL DEFAULT 0,
  extraction_method text NOT NULL DEFAULT 'pdf_text',
  PRIMARY KEY (document_id, page_number)
);

CREATE TABLE IF NOT EXISTS app.assignment_document_field_candidates (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES app.assignment_documents(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text,
  page_number integer,
  confidence numeric(5,4),
  evidence_excerpt text,
  extraction_method text NOT NULL DEFAULT 'labeled_text',
  review_status text NOT NULL DEFAULT 'suggested'
    CHECK (review_status IN ('suggested', 'confirmed', 'rejected')),
  confirmed_value text,
  reviewer text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignment_document_candidates_idx
  ON app.assignment_document_field_candidates (document_id, field_key, review_status);
