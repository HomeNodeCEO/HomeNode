BEGIN;

-- UAD established the canonical HomeNode identity tables. These roles extend
-- that same identity model to Custom Appraisal and Property Tax Protest.
INSERT INTO app_auth.roles (code, display_name, description)
VALUES
  ('office_assistant', 'Office assistant', 'Creates and maintains assignment data but cannot sign appraisal reports.'),
  ('read_only', 'Read-only user', 'May view authorized organization records but cannot modify or sign them.')
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

-- Legacy Custom Appraisal files are progressively assigned to an organization.
-- Nullable columns preserve existing production files until the controlled
-- Freeman Appraisal Services migration is run.
ALTER TABLE app.assignment_files
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS assigned_appraiser_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supervisory_appraiser_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS assignment_files_organization_recent_idx
  ON app.assignment_files (organization_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS assignment_files_assigned_appraiser_idx
  ON app.assignment_files (assigned_appraiser_user_id, updated_at DESC, id DESC)
  WHERE assigned_appraiser_user_id IS NOT NULL;

COMMIT;
