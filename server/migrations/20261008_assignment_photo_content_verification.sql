ALTER TABLE app.inspection_photo_objects
  ADD COLUMN IF NOT EXISTS checksum_sha256 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'inspection_photo_objects_checksum_sha256_check'
       AND conrelid = 'app.inspection_photo_objects'::regclass
  ) THEN
    ALTER TABLE app.inspection_photo_objects
      ADD CONSTRAINT inspection_photo_objects_checksum_sha256_check
      CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
END
$$;
