-- Derived CAD geometry only. Appraisal evidence remains an original,
-- assignment-authorized read of gis.dcad_parcels in its own snapshot.
-- Keep this derived index in the already-migrated app schema. Creating the GIS
-- source schema during application migrations would falsely claim that the
-- independent CAD sync has been installed.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.neighborhood_parcel_precompute (
  object_id bigint PRIMARY KEY,
  row_xmin text NOT NULL,
  source_record_hash text NOT NULL,
  geometry_sha256 text NOT NULL CHECK (geometry_sha256 ~ '^[0-9a-f]{64}$'),
  stored_geometry_ewkb text NOT NULL CHECK (stored_geometry_ewkb ~ '^[0-9a-f]+$'),
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.neighborhood_parcel_precompute_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  rows_scanned bigint NOT NULL DEFAULT 0,
  rows_refreshed bigint NOT NULL DEFAULT 0,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
