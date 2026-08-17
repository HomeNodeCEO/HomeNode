# HomeNode UAD 3.6 foundation

HomeNode's UAD implementation is an isolated domain inside the existing React,
Node, and PostgreSQL application. It does not reuse or mutate the Custom
Appraisal `app.assignment_files` records, and it does not change Property Tax
Protest data.

## Compliance position

HomeNode may build and use its own appraisal software without selling it to
other appraisers. Fannie Mae and Freddie Mac do not endorse appraisal software.
The report data, XML, native PDF, images, and delivery package must comply with
the current UAD 3.6 specification and the lender's delivery workflow.

Production access to a GSE UAD Compliance API is a separate integration. The
GSE verification and credential process applies to production API access even
when the software is used internally. Local schema and Appendix H validation
remain part of HomeNode's application so work does not depend on a remote API
for every edit.

## Isolation

- `app_auth`: organizations, users, memberships, roles, appraiser credentials,
  and future supervisory relationships.
- `uad_ref`: immutable specification releases, fields, enumerations, and
  compliance rules.
- `appraisal`: UAD workfiles, snapshots, repeatable entities, field provenance,
  revisions, validation, assets, sketches, signatures, and audit events.
- `/api/uad`: modular API mounted from the existing Node service.
- `dcad-frontend/src/features/uad`: UAD-only frontend code.

The UAD API is off by default. Apply the migration and set
`UAD_WORKSPACE_ENABLED=true` only in the target environment after validation.

## Staging strategy

The first staging gate is the `UAD foundation` GitHub Actions workflow. It
creates a disposable PostgreSQL 17/PostGIS database, installs a minimal
non-sensitive `core` contract, applies the UAD migration, verifies required
tables and roles, and applies the migration again to prove idempotency.

After the workflow is stable, create a separate Render `Staging` environment
with its own database and only sanitized fixture properties. Never connect a
staging service to `homenodedb`, and never copy owner/contact rows into staging.
Render preview databases are not the default because they require a Pro
workspace and incur per-preview resource charges.

## Mobile photos and artifacts

Cloudflare R2 is the initial private object store. The Node API issues a
short-lived, single-object presigned `PUT` URL. A mobile client uploads directly
to R2 with the required content type and then asks the API to verify the object.
R2 credentials are never sent to the mobile client.

Object keys are scoped by organization, UAD workfile, and asset UUID. PostgreSQL
stores the UAD section, entity, caption, capture metadata, checksum, byte size,
and verification state. It does not store the image bytes.

Sketch geometry, wall segments, dimensions, calculated ANSI areas, and
appraiser overrides are structured JSON in `appraisal.uad_sketches`. Rendered
SVG/PDF floor plans and supporting measurement files are private R2 assets.

Required server variables are documented in `server/.env.example`.

## Applying the migration

Run only after it succeeds in CI and the target has a current backup:

```sh
cd server
npm run migrate:uad
```

The runner uses an advisory lock and records the migration checksum in
`app.schema_migrations`. A changed migration that was already applied is
rejected instead of silently rerun.
