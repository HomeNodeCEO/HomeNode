# UAD disposable red-team environment

The red-team environment is a fourth deployment boundary. It is not the
existing UAD staging environment and must never reuse its database, R2 bucket,
OIDC application, credentials, or GSE configuration.

## Resource layout

| Resource | Required red-team property |
| --- | --- |
| API | New Render service from an immutable reviewed commit |
| Web | New frontend service whose API target is only the red-team API |
| Database | New database named with `redteam`, containing synthetic fixtures only |
| R2 | Private bucket and bucket-scoped read/write credential dedicated to red team |
| OIDC | Separate public PKCE client/audience and synthetic role identities |
| GSE | Disabled or local mock; official ACPT only in a separately approved window |
| DNS | Unique hostname, not an alias of staging or production |
| Observability | Request IDs, auth failures, 403/429/5xx, DB saturation, R2 requests/cost |
| Recovery | Pre-window snapshot plus rehearsed rebuild and credential revocation |

Start from `server/redteam.env.example`. Store populated values only in the
deployment secret manager. Set `UAD_SECURITY_STRICT=true`; startup must then
fail unless OIDC enforcement and an explicit HTTPS CORS allowlist are enabled.
Strict mode automatically enables the application rate limiter. Configure
Cloudflare rate limiting as the distributed outer control because the
application limiter is intentionally a per-process defense-in-depth control.

Use `npm run start:redteam:uad` for the API service. Its first command runs a
pre-migration isolation check and connects only far enough to verify that the
actual PostgreSQL database name contains `redteam`. It also refuses a
production-shaped bucket, origin, OIDC audience, live compliance/MLS/OCR/mail
credential, background data worker, or missing `synthetic_only` marker. The
subsequent fixture step refuses any non-synthetic organization, user, property,
UAD workfile, or report registry row before creating its authorization matrix.

The red-team database may begin as a separate clone of the reviewed synthetic
staging template; it must never be cloned from production. The configured
fixture account must use the `UAD-STAGING-` or `UAD-REDTEAM-` namespace. Static
checks do not prove cloud credential scope, so independently inspect the R2
token policy, Render resource links, and OIDC application before opening a test
window.

## Synthetic identities

Provision at least:

- assigned appraiser A in organization A;
- unassigned appraiser B in organization A;
- supervisory appraiser A in organization A;
- reviewer A in organization A;
- organization administrator A;
- appraiser C and administrator C in organization B;
- HomeNode administrator;
- active OIDC identity without a HomeNode mapping;
- inactive HomeNode user; and
- active user with suspended/inactive membership.

`REDTEAM_OIDC_SUBJECTS_JSON` maps the following exact persona keys to the
subject claim from eleven dedicated synthetic OIDC accounts:

- `assigned_appraiser_a`, `unassigned_appraiser_a`, `supervisor_a`,
  `reviewer_a`, and `organization_admin_a`;
- `appraiser_b` and `organization_admin_b`;
- `homenode_admin`, `inactive_user`, `suspended_member`, and
  `member_without_role`.

Keep one additional active OIDC identity intentionally absent from this JSON
and from `app_auth.oidc_identities`; it is the unprovisioned-user negative case.
Subject claims identify test mappings but are not access tokens; still store
the JSON in the deployment secret manager rather than the repository.

Never copy a real signature image, license number, email, phone number, client,
borrower, owner, address, appraisal, comparable photo, or document into this
environment.

## Activation sequence

1. Create and label every resource `redteam`; deny cross-environment access.
2. Set budget, concurrency, database-connection, body-size, and storage limits.
3. Snapshot the empty database and verify one-click credential revocation.
4. Deploy with the workspace disabled, then apply additive migrations.
5. Load only deterministic synthetic property and appraisal fixtures.
6. Configure bucket-scoped R2 and the red-team OIDC client.
7. Set the explicit frontend origin, strict mode, authentication enforcement,
   proxy hop count, and rate limit.
8. Keep both external Compliance API provider flags false.
9. Enable the workspace and require `/api/uad/readiness` to report all security
   checks ready.
10. Run ordinary smoke tests before any adversarial test.
11. Open a time-bounded test window and monitor logs/cost/latency continuously.
12. Close the window, revoke temporary identities and credentials, preserve
   sanitized evidence, and rebuild the disposable resources when integrity is
   uncertain.

## Kill conditions

Disable `UAD_WORKSPACE_ENABLED`, block the test source at Cloudflare, and revoke
the red-team R2/OIDC credentials if any stop condition in the security program
occurs. Do not delete the database or bucket until evidence has been preserved
and the incident owner confirms that no real data or external system was
reached.
