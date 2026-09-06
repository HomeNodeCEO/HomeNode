-- Additive retained evidence only. Run through the application migration owner;
-- never perform DDL from report reads or use these rows as authorization/facts.
-- The application checks the original canonical bytes and SHA together on every
-- replay/read. SQL JSON serialization is never an evidence digest preimage.
DO $$
BEGIN
  IF to_regclass('app_auth.organizations') IS NULL THEN
    RAISE EXCEPTION 'neighborhood_cohort_identity_prerequisite_missing';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'neighborhood_cohort_utf8_required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app.neighborhood_cohort_evidence_blobs (
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_utf8_bytes integer NOT NULL CHECK (canonical_utf8_bytes BETWEEN 1 AND 1500000),
  canonical_utf8 text NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, content_sha256),
  CHECK (octet_length(canonical_utf8) = canonical_utf8_bytes),
  CHECK (octet_length((canonical_utf8::jsonb)::text) <= 2000000)
);

COMMENT ON TABLE app.neighborhood_cohort_evidence_blobs IS
  'Organization-private immutable canonical evidence. Not original invocation authority or source eligibility. No global content lookup.';
COMMENT ON COLUMN app.neighborhood_cohort_evidence_blobs.stored_at IS
  'Storage time only; never the source capture time or proof of historical availability.';

CREATE OR REPLACE FUNCTION app.neighborhood_cohort_blob_reject_mutation_v1()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'neighborhood_cohort_blob_immutable';
END $$;

DROP TRIGGER IF EXISTS neighborhood_cohort_blob_immutable ON app.neighborhood_cohort_evidence_blobs;
CREATE TRIGGER neighborhood_cohort_blob_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_cohort_evidence_blobs
  FOR EACH STATEMENT EXECUTE FUNCTION app.neighborhood_cohort_blob_reject_mutation_v1();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_cohort_evidence_blobs FROM PUBLIC;
