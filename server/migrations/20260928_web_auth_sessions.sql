BEGIN;

CREATE TABLE IF NOT EXISTS app_auth.web_sessions (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_ip_sha256 text,
  created_user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(token_sha256) = 64),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS web_sessions_user_active_idx
  ON app_auth.web_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMIT;
