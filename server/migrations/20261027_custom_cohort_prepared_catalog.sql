-- Selection-neutral public catalog and recommendation derived from one retained
-- Custom neighborhood context. This is a read model, not evidence or authority.
CREATE TABLE app.neighborhood_custom_cohort_prepared_catalogs (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  format_version smallint NOT NULL CHECK (format_version = 1),
  catalog_version smallint NOT NULL CHECK (catalog_version = 3),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload_utf8_bytes integer NOT NULL CHECK (payload_utf8_bytes BETWEEN 1 AND 4000000),
  compressed_payload bytea NOT NULL CHECK (octet_length(compressed_payload) BETWEEN 1 AND 4000000),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, context_id, format_version, catalog_version),
  FOREIGN KEY (organization_id, context_id)
    REFERENCES app.neighborhood_custom_cohort_contexts (organization_id, context_id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_catalogs IS
  'Immutable selection-neutral Custom neighborhood catalog. Every use requires fresh assignment, original-context, market-policy and subject checks.';

CREATE TRIGGER neighborhood_custom_cohort_prepared_catalogs_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_catalogs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_catalogs FROM PUBLIC;
