# Custom signed-artifact staging audit

This is a manual, read-only checkpoint before planning any signed-PDF migration to R2. It does not modify signing, reports, photos, database rows, or object storage. Run staging first; do not point this workflow at production.

## Provision once

1. In the staging PostgreSQL database, create a dedicated credential with only `CONNECT`, `USAGE` on schema `app`, and `SELECT` on `app.custom_appraisal_signed_snapshots`, `app.custom_appraisal_report_artifacts`, `app.report_files`, `app.inspection_photos`, and `app.inspection_photo_objects`. Do not grant writes, ownership, `pg_read_all_data`, or `BYPASSRLS`. Confirm it can see the intended historical rows before interpreting zero counts. Revoke the credential when the audit window ends if it is temporary.
2. In GitHub, create the `custom-signed-artifact-staging-audit` environment. Restrict deployment branches to `main` and require a reviewer if available. Store the staging database's **external, certificate-verifiable** connection URL as environment secret `STAGING_SIGNED_ARTIFACT_AUDIT_DATABASE_URL`. Never paste the value into an issue, PR, workflow input, chat, or local file. Do not use `sslmode=disable` or an unverified/self-signed internal Render URL.
3. Confirm that staging is healthy and that no migration, backup, or load test is running. The PDF-byte digest query reads all stored PDF bytes inside PostgreSQL, with a 10-second statement timeout; choose a quiet window.

## Run and interpret

From GitHub Actions, manually dispatch **Custom signed artifact staging audit** on `main`. The job has read-only repository permissions, a staging-only environment, one database connection per audit, read-only transactions, bounded timeouts, and no uploaded artifacts. It emits aggregate counts and stable failure codes only. A connection failure, missing schema, mismatch, or timeout fails the job without printing the database URL or PDF contents.

Record the commit, date, environment, and aggregate counts in the security checkpoint. A passing result with zero signed snapshots or zero stored artifacts is **not** evidence that historical files were verified. A nonzero mismatch blocks the R2 migration and requires a separately scoped investigation; this workflow deliberately emits no file identifiers. The photo audit reflects current verified-photo state, not what appeared in a historical PDF. The byte audit verifies digest, `%PDF-` header, and stored length; it does not prove full renderability or an R2 copy.

Only after staging succeeds should a separate production execution plan be reviewed. Keep the signed-PDF-at-commit guarantee, E&O disposition, immutable original artifact, and new signed revision/object key requirements intact; this audit changes none of them.
