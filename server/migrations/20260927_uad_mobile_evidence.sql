CREATE UNIQUE INDEX IF NOT EXISTS uad_assets_active_mobile_photo_uidx
  ON appraisal.uad_assets (workfile_id, ((capture_metadata ->> 'mobile_photo_id')))
  WHERE status <> 'deleted' AND capture_metadata ? 'mobile_photo_id';

CREATE UNIQUE INDEX IF NOT EXISTS uad_assets_active_mobile_sketch_uidx
  ON appraisal.uad_assets (workfile_id, ((capture_metadata ->> 'mobile_sketch_id')))
  WHERE status <> 'deleted' AND capture_metadata ? 'mobile_sketch_id';

CREATE INDEX IF NOT EXISTS uad_assets_mobile_evidence_lookup_idx
  ON appraisal.uad_assets (
    workfile_id,
    ((capture_metadata ->> 'mobile_photo_id')),
    ((capture_metadata ->> 'mobile_sketch_id'))
  )
  WHERE status <> 'deleted'
    AND (capture_metadata ? 'mobile_photo_id' OR capture_metadata ? 'mobile_sketch_id');
