-- Immutable, display-only geometry tiles derived from one complete prepared
-- Custom neighborhood map. Analytical membership and report evidence remain
-- bound to the original context/preview, not to these tiles.
CREATE TABLE app.neighborhood_custom_cohort_prepared_tile_manifests (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  format_version smallint NOT NULL CHECK (format_version = 1),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  source_preview_sha256 text NOT NULL CHECK (source_preview_sha256 ~ '^[a-f0-9]{64}$'),
  source_map_sha256 text NOT NULL CHECK (source_map_sha256 ~ '^[a-f0-9]{64}$'),
  source_compressed_map_sha256 text NOT NULL CHECK (source_compressed_map_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('available','unavailable')),
  reason text CHECK (reason IN ('capacity_exceeded','membership_mismatch','source_unavailable')),
  captured_parcels integer CHECK (captured_parcels BETWEEN 1 AND 100000),
  account_set_sha256 text CHECK (account_set_sha256 ~ '^[a-f0-9]{64}$'),
  map_shell_json text CHECK (octet_length(map_shell_json) BETWEEN 1 AND 100000),
  map_shell_sha256 text CHECK (map_shell_sha256 ~ '^[a-f0-9]{64}$'),
  cell_keys_json text CHECK (octet_length(cell_keys_json) BETWEEN 1 AND 25000),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, context_id, format_version),
  FOREIGN KEY (organization_id, context_id, format_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_previews
      (organization_id, context_id, format_version) ON DELETE RESTRICT,
  CHECK ((status='available' AND reason IS NULL AND captured_parcels IS NOT NULL
      AND account_set_sha256 IS NOT NULL AND map_shell_json IS NOT NULL
      AND map_shell_sha256 IS NOT NULL AND cell_keys_json IS NOT NULL)
    OR (status='unavailable' AND reason IS NOT NULL AND captured_parcels IS NULL
      AND account_set_sha256 IS NULL AND map_shell_json IS NULL
      AND map_shell_sha256 IS NULL AND cell_keys_json IS NULL))
);

CREATE TABLE app.neighborhood_custom_cohort_prepared_tiles (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  format_version smallint NOT NULL CHECK (format_version = 1),
  cell_x integer NOT NULL,
  cell_y integer NOT NULL,
  tile_sha256 text NOT NULL CHECK (tile_sha256 ~ '^[a-f0-9]{64}$'),
  tile_utf8_bytes integer NOT NULL CHECK (tile_utf8_bytes BETWEEN 1 AND 4000000),
  compressed_tile bytea NOT NULL CHECK (octet_length(compressed_tile) BETWEEN 1 AND 2000000),
  PRIMARY KEY (organization_id, context_id, format_version, cell_x, cell_y),
  FOREIGN KEY (organization_id, context_id, format_version)
    REFERENCES app.neighborhood_custom_cohort_prepared_tile_manifests
      (organization_id, context_id, format_version) ON DELETE RESTRICT
);

COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_tiles IS
  'Exact parcel-display copies; never report membership, source evidence, or access authority.';
CREATE TRIGGER neighborhood_custom_cohort_prepared_tile_manifests_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_tile_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_custom_cohort_prepared_tiles_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_tiles
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_tile_manifests FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_tiles FROM PUBLIC;
