-- Display-only directory roots compiled once from complete checked immutable
-- catalog and numeric-preview originals. Source/assignment rights stay owned
-- by the request coordinator, not this derivative table.
CREATE TABLE app.neighborhood_custom_cohort_prepared_catalog_roots (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  format_version smallint NOT NULL CHECK (format_version=1),
  catalog_version smallint NOT NULL CHECK (catalog_version=3),
  source_catalog_format_version smallint NOT NULL CHECK (source_catalog_format_version IN (1,2)),
  catalog_sha256 text NOT NULL CHECK (catalog_sha256 ~ '^[a-f0-9]{64}$'),
  catalog_utf8_bytes integer NOT NULL CHECK (catalog_utf8_bytes BETWEEN 1 AND 4000000),
  compressed_catalog_sha256 text NOT NULL CHECK (compressed_catalog_sha256 ~ '^[a-f0-9]{64}$'),
  preview_sha256 text NOT NULL CHECK (preview_sha256 ~ '^[a-f0-9]{64}$'),
  preview_utf8_bytes integer NOT NULL CHECK (preview_utf8_bytes BETWEEN 1 AND 64000000),
  compressed_preview_sha256 text NOT NULL CHECK (compressed_preview_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_utf8_bytes integer NOT NULL CHECK (manifest_utf8_bytes BETWEEN 1 AND 16000),
  original_catalog_sha256 text NOT NULL CHECK (original_catalog_sha256 ~ '^[a-f0-9]{64}$'),
  original_catalog_utf8_bytes integer NOT NULL CHECK (original_catalog_utf8_bytes BETWEEN 1 AND 750000),
  source_read_model_sha256 text NOT NULL CHECK (source_read_model_sha256 ~ '^[a-f0-9]{64}$'),
  roster_account_ids_sha256 text NOT NULL CHECK (roster_account_ids_sha256 ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,context_id,format_version,source_catalog_format_version),
  FOREIGN KEY (organization_id,context_id,source_catalog_format_version,catalog_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_catalogs (organization_id,context_id,format_version,catalog_version) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,context_id,format_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_previews (organization_id,context_id,format_version) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,manifest_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,original_catalog_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256) ON DELETE RESTRICT
);
COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_catalog_roots IS
  'Immutable prepared display-original directory. Not source truth, analytical membership, access authority or accepted report evidence. Current owner checks original context/source/assignment/subject both ends.';
CREATE TRIGGER neighborhood_custom_cohort_prepared_catalog_roots_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_catalog_roots
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_catalog_roots FROM PUBLIC;
