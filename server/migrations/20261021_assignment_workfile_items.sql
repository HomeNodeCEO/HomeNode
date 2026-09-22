CREATE TABLE IF NOT EXISTS app.assignment_workfile_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE CASCADE,
  uad_workfile_id uuid REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  title text NOT NULL,
  original_file_name text,
  content_type text,
  file_size_bytes bigint,
  checksum_sha256 text,
  object_key text,
  external_url text,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignment_workfile_items_one_scope_check CHECK (
    ((assignment_file_id IS NOT NULL)::int + (uad_workfile_id IS NOT NULL)::int) = 1
  ),
  CONSTRAINT assignment_workfile_items_type_check CHECK (item_type IN ('file', 'link')),
  CONSTRAINT assignment_workfile_items_payload_check CHECK (
    (item_type = 'file'
      AND original_file_name IS NOT NULL
      AND content_type IS NOT NULL
      AND file_size_bytes IS NOT NULL
      AND checksum_sha256 IS NOT NULL
      AND object_key IS NOT NULL
      AND external_url IS NULL)
    OR
    (item_type = 'link'
      AND external_url IS NOT NULL
      AND original_file_name IS NULL
      AND content_type IS NULL
      AND file_size_bytes IS NULL
      AND checksum_sha256 IS NULL
      AND object_key IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS assignment_workfile_items_custom_scope_idx
  ON app.assignment_workfile_items (assignment_file_id, created_at DESC, id DESC)
  WHERE assignment_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS assignment_workfile_items_uad_scope_idx
  ON app.assignment_workfile_items (uad_workfile_id, created_at DESC, id DESC)
  WHERE uad_workfile_id IS NOT NULL;
