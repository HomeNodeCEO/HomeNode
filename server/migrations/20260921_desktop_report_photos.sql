ALTER TABLE app.inspection_photos
  ALTER COLUMN inspection_session_id DROP NOT NULL,
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE app.inspection_photos
  ADD COLUMN IF NOT EXISTS origin_channel text NOT NULL DEFAULT 'mobile';

ALTER TABLE app.inspection_photos
  DROP CONSTRAINT IF EXISTS inspection_photos_origin_channel_check;

ALTER TABLE app.inspection_photos
  ADD CONSTRAINT inspection_photos_origin_channel_check CHECK (
    (origin_channel = 'mobile' AND inspection_session_id IS NOT NULL AND organization_id IS NOT NULL)
    OR
    (origin_channel = 'desktop' AND inspection_session_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS inspection_photos_report_client_uidx
  ON app.inspection_photos (report_file_id, client_photo_id);

CREATE INDEX IF NOT EXISTS inspection_photos_report_origin_idx
  ON app.inspection_photos (report_file_id, origin_channel, status, position, created_at);

ALTER TABLE app.inspection_photo_events
  ALTER COLUMN inspection_session_id DROP NOT NULL;
