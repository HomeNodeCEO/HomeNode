-- The application migration runner installs the retention index concurrently
-- after committing this schema phase and before recording the migration. Keep
-- this file transaction-owned by the runner; the resumable post-migration step
-- is safe to retry after a deploy interruption.
SELECT 1 AS auth_session_retention_post_migration_required;
