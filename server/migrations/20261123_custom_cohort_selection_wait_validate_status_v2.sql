-- The migration runner commits each file independently. Installation of the
-- superset CHECK has already committed and released ACCESS EXCLUSIVE before
-- this scan starts. PostgreSQL VALIDATE uses SHARE UPDATE EXCLUSIVE, permitting
-- ordinary capture-job claims, heartbeats and cancellations during the scan.
-- NOT VALID already enforces the CHECK on every new or updated row.
ALTER TABLE app.neighborhood_custom_cohort_capture_jobs
  VALIDATE CONSTRAINT neighborhood_custom_cohort_capture_jobs_status_check;
