BEGIN;

ALTER TABLE app.custom_appraisal_signed_snapshots
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS signed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS signature_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS signed_from_ip text,
  ADD COLUMN IF NOT EXISTS signed_user_agent text,
  ADD COLUMN IF NOT EXISTS signature_hmac_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS custom_appraisal_signed_signature_event_uidx
  ON app.custom_appraisal_signed_snapshots (signature_event_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'custom_appraisal_signature_hmac_check'
       AND conrelid = 'app.custom_appraisal_signed_snapshots'::regclass
  ) THEN
    ALTER TABLE app.custom_appraisal_signed_snapshots
      ADD CONSTRAINT custom_appraisal_signature_hmac_check
      CHECK (signature_hmac_sha256 IS NULL OR signature_hmac_sha256 ~ '^[a-f0-9]{64}$');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.prevent_custom_appraisal_signed_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'custom_appraisal_signed_snapshot_append_only'
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS custom_appraisal_signed_snapshot_append_only
  ON app.custom_appraisal_signed_snapshots;
CREATE TRIGGER custom_appraisal_signed_snapshot_append_only
BEFORE UPDATE OR DELETE ON app.custom_appraisal_signed_snapshots
FOR EACH ROW EXECUTE FUNCTION app.prevent_custom_appraisal_signed_snapshot_mutation();

COMMIT;
