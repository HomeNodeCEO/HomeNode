BEGIN;

CREATE INDEX IF NOT EXISTS web_sessions_expiry_cleanup_idx
  ON app_auth.web_sessions (expires_at, id);

CREATE INDEX IF NOT EXISTS web_sessions_revoked_cleanup_idx
  ON app_auth.web_sessions (revoked_at, id)
  WHERE revoked_at IS NOT NULL;

COMMIT;
