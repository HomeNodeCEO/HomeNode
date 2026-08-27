ALTER TABLE appraisal.uad_sketches
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE appraisal.uad_sketches
  DROP CONSTRAINT IF EXISTS uad_sketches_revision_check;

ALTER TABLE appraisal.uad_sketches
  ADD CONSTRAINT uad_sketches_revision_check CHECK (revision >= 1);

CREATE TABLE IF NOT EXISTS appraisal.uad_sketch_history (
  id bigserial PRIMARY KEY,
  sketch_id uuid NOT NULL REFERENCES appraisal.uad_sketches(id) ON DELETE RESTRICT,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  geometry jsonb NOT NULL,
  measurements jsonb NOT NULL,
  calculated_areas jsonb NOT NULL,
  area_overrides jsonb NOT NULL,
  rendered_asset_id uuid REFERENCES appraisal.uad_assets(id) ON DELETE SET NULL,
  source text NOT NULL,
  changed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  change_source text NOT NULL DEFAULT 'homenode_web_editor',
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sketch_id, revision),
  CHECK (revision >= 1),
  CHECK (jsonb_typeof(geometry) = 'object'),
  CHECK (jsonb_typeof(measurements) = 'object'),
  CHECK (jsonb_typeof(calculated_areas) = 'object'),
  CHECK (jsonb_typeof(area_overrides) = 'object')
);

CREATE INDEX IF NOT EXISTS uad_sketch_history_workfile_revision_idx
  ON appraisal.uad_sketch_history (workfile_id, sketch_id, revision DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uad_assets_active_sketch_editor_revision_uidx
  ON appraisal.uad_assets (workfile_id, (capture_metadata ->> 'uad_sketch_editor_revision'))
  WHERE status <> 'deleted' AND capture_metadata ? 'uad_sketch_editor_revision';

INSERT INTO appraisal.uad_sketch_history (
  sketch_id, workfile_id, revision, geometry, measurements,
  calculated_areas, area_overrides, rendered_asset_id, source,
  changed_by_user_id, change_source, changed_at
)
SELECT sketch.id, sketch.workfile_id, sketch.revision, sketch.geometry,
       sketch.measurements, sketch.calculated_areas, sketch.area_overrides,
       sketch.rendered_asset_id, sketch.source,
       COALESCE(sketch.updated_by_user_id, sketch.created_by_user_id),
       'migration_snapshot', sketch.updated_at
  FROM appraisal.uad_sketches sketch
ON CONFLICT (sketch_id, revision) DO NOTHING;
