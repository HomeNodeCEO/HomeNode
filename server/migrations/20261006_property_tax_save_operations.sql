CREATE TABLE IF NOT EXISTS app.tax_protest_save_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_protest_file_id uuid NOT NULL
    REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  base_revision integer NOT NULL,
  applied_revision integer NOT NULL,
  result jsonb NOT NULL,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_protest_file_id, client_operation_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (base_revision >= 1),
  CHECK (applied_revision = base_revision + 1),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS tax_protest_save_operations_actor_idx
  ON app.tax_protest_save_operations (actor_user_id, created_at DESC, id);
