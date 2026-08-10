BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.assignment_files (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
  file_number text NOT NULL,
  assignment_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  inherited_from_file_id bigint REFERENCES app.assignment_files(id) ON DELETE SET NULL,
  reviewer text NOT NULL DEFAULT 'HomeNode editor',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, file_number)
);

CREATE INDEX IF NOT EXISTS assignment_files_account_created_idx
  ON app.assignment_files (account_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS assignment_files_account_file_number_ci_uidx
  ON app.assignment_files (account_id, lower(file_number));

CREATE TABLE IF NOT EXISTS app.assignment_file_history (
  id bigserial PRIMARY KEY,
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  file_number text NOT NULL,
  assignment_details jsonb NOT NULL,
  reviewer text NOT NULL,
  revision integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assignment_file_history_file_idx
  ON app.assignment_file_history (assignment_file_id, revision DESC, changed_at DESC);

COMMIT;
