# Production durability audit — 2026-08-25

This record captures settings verified in the provider consoles. It contains no
credentials, connection strings, service identifiers, database role names, or
object keys.

## Controls verified

| Control | Observed production state | Assessment |
| --- | --- | --- |
| Active-file persistence | Canonical PostgreSQL revision transaction; browser autosave target is 10 seconds idle and 55 seconds maximum wait | Implemented in this release |
| Database PITR | Enabled with a three-day recovery window | Useful short-horizon protection; add independent longer retention |
| Logical exports | Provider feature is available with at least seven days of retention, but no completed export was visible during this audit | Schedule and alert on an independent logical backup |
| Database high availability | Not enabled and unavailable on the current Basic database plan | An individual database/host failure can exceed the active-file RPO; move to an HA-capable plan before production appraisal volume |
| Database storage | 100 GB provisioned and approximately 37% used; automatic storage scaling is disabled | Current headroom is acceptable; alert before 70% and enable a bounded scaling policy |
| Database connection pooling | Provider pooler is disabled; the application pool is bounded | Reassess with load-test evidence before adding another pooling layer |
| External database access | Inbound database networking permits all external IPv4 sources | High-priority hardening item; inventory every legitimate external client, then restrict the allowlist without cutting off operations |
| Service health monitoring | Render health-check path is `/health` | Enabled during this audit |
| Production deployment gate | Auto-deploy waits for GitHub CI checks to pass | Enabled during this audit |
| Pre-deploy migration gate | No provider pre-deploy command is configured | Keep migrations in an explicit controlled release step until runtime and migration credentials are separated |
| R2 bucket isolation | The production web service currently points at `homenode-uad-staging` | High-priority isolation item; do not change in place until referenced objects are inventoried and a migration/read-fallback plan is tested |
| R2 retention lock | Not changed during this audit | Correct until HomeNode approves a written retention and legal-hold schedule |

## Required follow-through

1. Create a dedicated production R2 bucket and production-scoped credential.
   Inventory every PostgreSQL object reference, copy and checksum-verify existing
   production objects, support a temporary read fallback, then move new writes.
   Never point staging/red-team cleanup at the production bucket.
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
