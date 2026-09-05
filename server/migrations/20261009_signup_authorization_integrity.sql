CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.signups (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text,
  account_id text,
  owner_name text NOT NULL,
  owner_telephone text NOT NULL,
  owner_email text,
  user_agent text,
  ip text,
  meta jsonb
);

ALTER TABLE app.signups
  ADD COLUMN IF NOT EXISTS submission_id uuid,
  ADD COLUMN IF NOT EXISTS property_tax_file_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'legacy_unverified',
  ADD COLUMN IF NOT EXISTS signer_printed_name text,
  ADD COLUMN IF NOT EXISTS signer_title text,
  ADD COLUMN IF NOT EXISTS signer_role text,
  ADD COLUMN IF NOT EXISTS signature_sha256 text,
  ADD COLUMN IF NOT EXISTS signature_png bytea,
  ADD COLUMN IF NOT EXISTS authorization_sha256 text,
  ADD COLUMN IF NOT EXISTS attestation_accepted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signups_verification_status_check'
      AND conrelid = 'app.signups'::regclass
  ) THEN
    ALTER TABLE app.signups
      ADD CONSTRAINT signups_verification_status_check
      CHECK (verification_status IN (
        'legacy_unverified',
        'pending_manual_verification',
        'verified',
        'rejected'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signups_verified_artifact_check'
      AND conrelid = 'app.signups'::regclass
  ) THEN
    ALTER TABLE app.signups
      ADD CONSTRAINT signups_verified_artifact_check
      CHECK (
        verification_status = 'legacy_unverified'
        OR (
          submission_id IS NOT NULL
          AND property_tax_file_id IS NOT NULL
          AND organization_id IS NOT NULL
          AND submitted_by_user_id IS NOT NULL
          AND signer_printed_name IS NOT NULL
          AND signer_role IS NOT NULL
          AND signature_sha256 ~ '^[a-f0-9]{64}$'
          AND signature_png IS NOT NULL
          AND authorization_sha256 ~ '^[a-f0-9]{64}$'
          AND attestation_accepted_at IS NOT NULL
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signups_property_tax_file_fk'
      AND conrelid = 'app.signups'::regclass
  ) THEN
    ALTER TABLE app.signups
      ADD CONSTRAINT signups_property_tax_file_fk
      FOREIGN KEY (property_tax_file_id)
      REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signups_organization_fk'
      AND conrelid = 'app.signups'::regclass
  ) THEN
    ALTER TABLE app.signups
      ADD CONSTRAINT signups_organization_fk
      FOREIGN KEY (organization_id)
      REFERENCES app_auth.organizations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'signups_submitted_by_user_fk'
      AND conrelid = 'app.signups'::regclass
  ) THEN
    ALTER TABLE app.signups
      ADD CONSTRAINT signups_submitted_by_user_fk
      FOREIGN KEY (submitted_by_user_id)
      REFERENCES app_auth.users(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS signups_submission_id_uidx
  ON app.signups (submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signups_property_tax_file_created_idx
  ON app.signups (property_tax_file_id, created_at DESC, id DESC)
  WHERE property_tax_file_id IS NOT NULL;
