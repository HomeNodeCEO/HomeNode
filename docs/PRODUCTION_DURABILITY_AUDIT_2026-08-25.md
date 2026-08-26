# Production durability audit — 2026-08-25

This record captures settings verified in the provider consoles. It contains no
credentials, connection strings, service identifiers, database role names, or
object keys.

## Controls verified

| Control | Observed production state | Assessment |
| --- | --- | --- |
| Active-file persistence | Canonical PostgreSQL revision transaction; browser autosave target is 10 seconds idle and 55 seconds maximum wait | Implemented in this release |
| Database PITR | Enabled with a three-day recovery window | Useful short-horizon protection; add independent longer retention |
| Logical exports | A fresh provider logical export was requested during this audit; Render retains completed exports for at least seven days | Verify completion, then add an independently stored longer-retention backup and restore drill |
| Database high availability | Not enabled and unavailable on the current Basic database plan | An individual database/host failure can exceed the active-file RPO; move to an HA-capable plan before production appraisal volume |
| Database storage | 100 GB provisioned and approximately 37% used; automatic storage scaling is disabled | Current headroom is acceptable; alert before 70% and enable a bounded scaling policy |
| Database connection pooling | Provider pooler is disabled; the application pool is bounded | Reassess with load-test evidence before adding another pooling layer |
| External database access | Inbound database networking permits all external IPv4 sources | High-priority hardening item; inventory every legitimate external client, then restrict the allowlist without cutting off operations |
| Service health monitoring | Render health-check path is `/health` | Enabled during this audit |
| Production deployment gate | Auto-deploy waits for GitHub CI checks to pass | Enabled during this audit |
| Pre-deploy migration gate | Render runs `npm run migrate:uad` before starting each production release | Enabled during this audit; the advisory-locked, checksummed runner is UAD-only and does not run Custom Appraisal, Property Tax, or mobile migrations |
| R2 bucket isolation | A private `homenode-uad-production` bucket now exists. The application supports dedicated `UAD_R2_BUCKET`, `UAD_R2_ACCOUNT_ID`, `UAD_R2_ACCESS_KEY_ID`, and `UAD_R2_SECRET_ACCESS_KEY` overrides while preserving the shared `R2_*` configuration for Custom Appraisal documents and shared mobile photos | Activate after CI, then run the credential-safe object round-trip probe; current UAD inventory contains no objects requiring migration |
| R2 retention lock | Not changed during this audit | Correct until HomeNode approves a written retention and legal-hold schedule |

## Required follow-through

1. Activate the dedicated production R2 bucket with `UAD_R2_BUCKET`, run
   `npm run verify:uad:object-storage`, and confirm the public capability and
   readiness summaries report storage isolation. A production-scoped R2
   credential remains a defense-in-depth follow-up; never point staging or
   red-team cleanup at the production bucket.
2. Restrict database external access after recording the exact current clients.
   Prefer Render private networking for Render services and narrowly scoped
   allowlist entries for approved administrative access.
3. Provision a non-owning runtime database login and a separate migration login,
   then run `npm run audit:database-privileges` in enforce mode.
4. Schedule an encrypted logical backup in an independent failure domain and a
   disposable restore drill that runs migrations, fixture checks, and
   `npm run audit:assurance:uad`.
5. Decide the required RPO/RTO and retention/legal-hold periods in writing before
   purchasing HA capacity or applying irreversible bucket locks.

The database and R2 isolation findings do not invalidate the minute-level
autosave implementation. They describe the remaining infrastructure work needed
to preserve that recovery objective through a provider, credential, or operator
failure rather than only an application-process failure.

## Post-release evidence

After the CI-approved release deployed, production reported all 41 ordered UAD
migrations applied with no checksum mismatch and no readiness blocker. The UAD
assurance graph passed every invariant with zero findings across two workfiles,
three immutable revisions, eleven entities, and 34 canonical field values. The
public `/health` and `/api/uad/readiness` endpoints both returned HTTP 200 after
the migration.

The privilege audit confirmed that the application still uses the provider
owner credential: it owns and can create in all five application schemas and
can create database roles and databases. It is not a superuser, cannot
replicate, and cannot bypass row security. Runtime/migration credential
separation therefore remains a high-priority infrastructure item; the audit
must stay in report mode until that cutover is tested.

The isolated UAD storage release passed CI and deployed successfully. A live
write/read/checksum/delete probe then received HTTP 401 from R2, proving the
existing credential is scoped away from the new production bucket. The
`UAD_R2_BUCKET` binding was immediately removed and the service redeployed on
the known-good shared-bucket fallback. Production health and UAD readiness
returned HTTP 200 with all 41 migrations and no blockers after rollback. The
dedicated bucket remains private and empty; isolation will be activated only
after a credential authorized for that bucket is installed and the same probe
passes. No Custom Appraisal document or shared mobile-photo binding changed.
