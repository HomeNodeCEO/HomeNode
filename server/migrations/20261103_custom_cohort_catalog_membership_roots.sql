-- Supplement the existing display root with the actual whole-catalog member
-- graph in the SAME caller transaction. Never an appraiser selection/head.
CREATE TABLE app.neighborhood_custom_cohort_catalog_membership_roots (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  format_version smallint NOT NULL CHECK (format_version=1),
  display_format_version smallint NOT NULL CHECK (display_format_version=1),
  source_catalog_format_version smallint NOT NULL CHECK (source_catalog_format_version IN (1,2)),
  display_manifest_sha256 text NOT NULL CHECK (display_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  display_manifest_utf8_bytes integer NOT NULL CHECK (display_manifest_utf8_bytes BETWEEN 1 AND 16000),
  witness_sha256 text NOT NULL CHECK (witness_sha256 ~ '^[a-f0-9]{64}$'),
  witness_utf8_bytes integer NOT NULL CHECK (witness_utf8_bytes BETWEEN 1 AND 4000),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,context_id,format_version,source_catalog_format_version),
  FOREIGN KEY (organization_id,context_id,display_format_version,source_catalog_format_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_catalog_roots
      (organization_id,context_id,format_version,source_catalog_format_version) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,display_manifest_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,witness_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256) ON DELETE RESTRICT
);
COMMENT ON TABLE app.neighborhood_custom_cohort_catalog_membership_roots IS
  'Immutable whole-catalog original member graph. Not selected head, source truth, access grant, analytical statistics or report authority. Current owner authorizes both ends.';
CREATE TRIGGER neighborhood_custom_cohort_catalog_membership_roots_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_catalog_membership_roots
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_catalog_membership_roots FROM PUBLIC;
