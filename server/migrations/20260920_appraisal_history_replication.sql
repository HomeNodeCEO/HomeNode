CREATE TABLE IF NOT EXISTS app.appraisal_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE RESTRICT,
  effective_date date,
  inspection_date date,
  status text NOT NULL DEFAULT 'active',
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'completed', 'cancelled', 'archived'))
);

CREATE INDEX IF NOT EXISTS appraisal_cases_account_recent_idx
  ON app.appraisal_cases (account_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app.appraisal_subject_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appraisal_case_id uuid NOT NULL REFERENCES app.appraisal_cases(id) ON DELETE RESTRICT,
  snapshot_version integer NOT NULL,
  parent_snapshot_id uuid REFERENCES app.appraisal_subject_snapshots(id) ON DELETE RESTRICT,
  source_report_file_id uuid REFERENCES app.report_files(id) ON DELETE RESTRICT,
  verification_status text NOT NULL DEFAULT 'captured',
  effective_date date,
  inspection_date date,
  subject_data jsonb NOT NULL,
  source_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum_sha256 text,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appraisal_case_id, snapshot_version),
  CHECK (snapshot_version >= 1),
  CHECK (verification_status IN ('captured', 'unverified', 'confirmed', 'superseded')),
  CHECK (jsonb_typeof(subject_data) = 'object'),
  CHECK (jsonb_typeof(source_manifest) = 'object'),
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS appraisal_subject_snapshots_case_recent_idx
  ON app.appraisal_subject_snapshots (appraisal_case_id, snapshot_version DESC, created_at DESC);

ALTER TABLE app.report_files
  ADD COLUMN IF NOT EXISTS appraisal_case_id uuid REFERENCES app.appraisal_cases(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS subject_snapshot_id uuid REFERENCES app.appraisal_subject_snapshots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS replication_mode text NOT NULL DEFAULT 'original';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'report_files_replication_mode_check'
       AND conrelid = 'app.report_files'::regclass
  ) THEN
    ALTER TABLE app.report_files
      ADD CONSTRAINT report_files_replication_mode_check
      CHECK (replication_mode IN ('original', 'same_assignment_alternate', 'new_assignment_template'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS report_files_appraisal_case_idx
  ON app.report_files (appraisal_case_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app.appraisal_file_replications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  target_report_file_id uuid NOT NULL UNIQUE REFERENCES app.report_files(id) ON DELETE RESTRICT,
  source_snapshot_id uuid NOT NULL REFERENCES app.appraisal_subject_snapshots(id) ON DELETE RESTRICT,
  replication_mode text NOT NULL,
  source_workflow_type text NOT NULL,
  target_workflow_type text NOT NULL,
  change_review_required boolean NOT NULL,
  attestation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (replication_mode IN ('same_assignment_alternate', 'new_assignment_template')),
  CHECK (source_workflow_type IN ('custom_appraisal', 'uad_3_6')),
  CHECK (target_workflow_type IN ('custom_appraisal', 'uad_3_6')),
  CHECK (jsonb_typeof(attestation) = 'object'),
  CHECK (
    (replication_mode = 'same_assignment_alternate' AND change_review_required = false)
    OR
    (replication_mode = 'new_assignment_template' AND change_review_required = true)
  )
);

CREATE INDEX IF NOT EXISTS appraisal_file_replications_source_idx
  ON app.appraisal_file_replications (source_report_file_id, created_at DESC, id);

WITH missing_cases AS (
  SELECT report_file.id AS report_file_id, gen_random_uuid() AS appraisal_case_id
    FROM app.report_files report_file
   WHERE report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
     AND report_file.appraisal_case_id IS NULL
), inserted_cases AS (
  INSERT INTO app.appraisal_cases (
    id, organization_id, account_id, created_by_user_id, created_at, updated_at
  )
  SELECT missing.appraisal_case_id, report_file.organization_id, report_file.account_id,
         report_file.created_by_user_id, report_file.created_at, report_file.updated_at
    FROM missing_cases missing
    JOIN app.report_files report_file ON report_file.id = missing.report_file_id
  RETURNING id
)
UPDATE app.report_files report_file
   SET appraisal_case_id = missing.appraisal_case_id
  FROM missing_cases missing
  JOIN inserted_cases inserted ON inserted.id = missing.appraisal_case_id
 WHERE report_file.id = missing.report_file_id;

INSERT INTO app.appraisal_subject_snapshots (
  appraisal_case_id,
  snapshot_version,
  source_report_file_id,
  verification_status,
  subject_data,
  source_manifest,
  checksum_sha256,
  created_by_user_id,
  created_at
)
SELECT
  report_file.appraisal_case_id,
  1,
  report_file.id,
  CASE
    WHEN custom_workfile.status = 'signed' OR uad_workfile.status IN ('signed', 'exported', 'submitted')
      THEN 'confirmed'
    ELSE 'captured'
  END,
  jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 1,
    'workflow_type', report_file.workflow_type,
    'account', to_jsonb(account),
    'assignment_details', assignment_file.assignment_details,
    'property_characteristics', custom_section.section_value,
    'custom_signed_snapshot', custom_signed.snapshot,
    'uad_subject_snapshot', uad_subject.subject_data,
    'uad_subject_source_manifest', uad_subject.source_manifest
  )),
  jsonb_build_object(
    'capture_reason', 'migration_backfill',
    'report_file_id', report_file.id,
    'captured_at', report_file.updated_at
  ),
  NULL,
  report_file.created_by_user_id,
  report_file.created_at
FROM app.report_files report_file
JOIN core.accounts account ON account.account_id = report_file.account_id
LEFT JOIN app.assignment_files assignment_file
  ON assignment_file.id = report_file.custom_assignment_file_id
LEFT JOIN app.custom_appraisal_workfiles custom_workfile
  ON custom_workfile.assignment_file_id = report_file.custom_assignment_file_id
LEFT JOIN app.custom_appraisal_signed_snapshots custom_signed
  ON custom_signed.assignment_file_id = report_file.custom_assignment_file_id
LEFT JOIN app.custom_appraisal_sections custom_section
  ON custom_section.assignment_file_id = report_file.custom_assignment_file_id
 AND custom_section.section_key = 'report.property_characteristics'
LEFT JOIN appraisal.uad_workfiles uad_workfile
  ON uad_workfile.id = report_file.uad_workfile_id
LEFT JOIN LATERAL (
  SELECT snapshot.subject_data, snapshot.source_manifest
    FROM appraisal.uad_subject_snapshots snapshot
   WHERE snapshot.workfile_id = report_file.uad_workfile_id
   ORDER BY snapshot.snapshot_version DESC
   LIMIT 1
) uad_subject ON true
WHERE report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
  AND report_file.appraisal_case_id IS NOT NULL
  AND report_file.subject_snapshot_id IS NULL
ON CONFLICT (appraisal_case_id, snapshot_version) DO NOTHING;

UPDATE app.report_files report_file
   SET subject_snapshot_id = snapshot.id
  FROM app.appraisal_subject_snapshots snapshot
 WHERE snapshot.appraisal_case_id = report_file.appraisal_case_id
   AND snapshot.source_report_file_id = report_file.id
   AND report_file.subject_snapshot_id IS NULL;
