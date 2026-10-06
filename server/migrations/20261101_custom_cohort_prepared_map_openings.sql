-- Compact map-opening display metadata, derived once from the same complete
-- immutable catalog, numeric preview and parcel map. No selection or authority.
CREATE TABLE app.neighborhood_custom_cohort_prepared_map_openings (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  format_version smallint NOT NULL CHECK (format_version = 1),
  catalog_version smallint NOT NULL CHECK (catalog_version = 3),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  source_catalog_sha256 text NOT NULL CHECK (source_catalog_sha256 ~ '^[a-f0-9]{64}$'),
  source_compressed_catalog_sha256 text NOT NULL CHECK (source_compressed_catalog_sha256 ~ '^[a-f0-9]{64}$'),
  source_preview_sha256 text NOT NULL CHECK (source_preview_sha256 ~ '^[a-f0-9]{64}$'),
  source_compressed_preview_sha256 text NOT NULL CHECK (source_compressed_preview_sha256 ~ '^[a-f0-9]{64}$'),
  source_map_sha256 text NOT NULL CHECK (source_map_sha256 ~ '^[a-f0-9]{64}$'),
  source_compressed_map_sha256 text NOT NULL CHECK (source_compressed_map_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('available','unavailable')),
  reason text CHECK (reason IN ('capacity_exceeded','source_invalid','catalog_geometry_mismatch')),
  payload_sha256 text CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload_utf8_bytes integer CHECK (payload_utf8_bytes BETWEEN 1 AND 4000000),
  compressed_payload bytea CHECK (octet_length(compressed_payload) BETWEEN 1 AND 4000000),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, context_id, format_version),
  FOREIGN KEY (organization_id, context_id, format_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_previews
      (organization_id, context_id, format_version) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, context_id, format_version, catalog_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_catalogs
      (organization_id, context_id, format_version, catalog_version) ON DELETE RESTRICT,
  CHECK ((status='available' AND reason IS NULL AND payload_sha256 IS NOT NULL
      AND payload_utf8_bytes IS NOT NULL AND compressed_payload IS NOT NULL)
    OR (status='unavailable' AND reason IS NOT NULL AND payload_sha256 IS NULL
      AND payload_utf8_bytes IS NULL AND compressed_payload IS NULL))
);
COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_map_openings IS
  'Immutable compact display metadata; every use requires fresh original-context, assignment, subject and source authorization. Never analytical membership or accepted report evidence.';
CREATE TRIGGER neighborhood_custom_cohort_prepared_map_openings_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_map_openings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_map_openings FROM PUBLIC;
