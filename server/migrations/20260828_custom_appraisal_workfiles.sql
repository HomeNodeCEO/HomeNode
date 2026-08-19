CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfiles (
  assignment_file_id bigint PRIMARY KEY REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  workfile_key uuid NOT NULL DEFAULT gen_random_uuid(),
  canonical_file_name text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  signed_at timestamptz,
  signed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_key),
  UNIQUE (canonical_file_name),
  CHECK (schema_version >= 1),
  CHECK (status IN ('draft', 'signed', 'archived')),
  CHECK (
    (status = 'signed' AND signed_at IS NOT NULL)
    OR (status <> 'signed')
  )
);

CREATE INDEX IF NOT EXISTS custom_appraisal_workfiles_status_updated_idx
  ON app.custom_appraisal_workfiles (status, updated_at DESC, assignment_file_id);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfile_sections (
  assignment_file_id bigint NOT NULL REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
  section_key text NOT NULL,
  section_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL DEFAULT 'HomeNode editor',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_file_id, section_key),
  CHECK (section_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CHECK (jsonb_typeof(section_value) = 'object'),
  CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_workfile_section_history (
  id bigserial PRIMARY KEY,
  assignment_file_id bigint NOT NULL REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
  section_key text NOT NULL,
  section_value jsonb NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL DEFAULT 'autosave',
  changed_by text NOT NULL DEFAULT 'HomeNode editor',
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_file_id, section_key, revision),
  CHECK (section_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  CHECK (jsonb_typeof(section_value) = 'object'),
  CHECK (revision >= 1),
  CHECK (event_type IN ('autosave', 'manual_save', 'legacy_import', 'signed'))
);

CREATE INDEX IF NOT EXISTS custom_appraisal_workfile_section_history_idx
  ON app.custom_appraisal_workfile_section_history
    (assignment_file_id, section_key, revision DESC, changed_at DESC);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_signed_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_file_id bigint NOT NULL UNIQUE REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
  canonical_file_name text NOT NULL UNIQUE,
  schema_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  checksum_sha256 text NOT NULL,
  signed_by text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (schema_version >= 1),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$')
);

INSERT INTO app.custom_appraisal_workfiles (
  assignment_file_id,
  canonical_file_name
)
SELECT
  assignment_file.id,
  COALESCE(
    NULLIF(left(
      trim(both '-' from regexp_replace(lower(assignment_file.file_number), '[^a-z0-9]+', '-', 'g')),
      72
    ), ''),
    'appraisal'
  ) || '-' || assignment_file.id::text || '.homenode-appraisal.json'
FROM app.assignment_files assignment_file
ON CONFLICT (assignment_file_id) DO NOTHING;
