-- A derived, immutable read model for rapid Custom neighborhood previews.
-- It is not original evidence, access authority, report adoption, or a source
-- of historical facts. Each read still checks its original context and policy.
CREATE TABLE app.neighborhood_custom_cohort_prepared_previews (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  format_version smallint NOT NULL CHECK (format_version = 1),
  preview_sha256 text NOT NULL CHECK (preview_sha256 ~ '^[a-f0-9]{64}$'),
  preview_utf8_bytes integer NOT NULL CHECK (preview_utf8_bytes BETWEEN 1 AND 64000000),
  compressed_preview bytea NOT NULL CHECK (octet_length(compressed_preview) BETWEEN 1 AND 12000000),
  map_sha256 text NOT NULL CHECK (map_sha256 ~ '^[a-f0-9]{64}$'),
  map_utf8_bytes integer NOT NULL CHECK (map_utf8_bytes BETWEEN 1 AND 32000000),
  compressed_map bytea NOT NULL CHECK (octet_length(compressed_map) BETWEEN 1 AND 16000000),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, context_id, format_version),
  FOREIGN KEY (organization_id, context_id)
    REFERENCES app.neighborhood_custom_cohort_contexts (organization_id, context_id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_previews IS
  'Immutable derived numeric and map preview. Requires fresh assignment, original-context, source-policy and subject checks before every use.';

CREATE TRIGGER neighborhood_custom_cohort_prepared_previews_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_previews
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_previews FROM PUBLIC;
