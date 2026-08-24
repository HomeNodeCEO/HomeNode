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
| OIDC | Separate provider boundary or deterministic test issuer and synthetic role identities |
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

The red-team database must begin empty and must never be cloned from production.
`npm run prepare:redteam:base` creates only the minimum shared property schema
and one deterministic single-family fixture before the additive UAD/mobile
migrations run. It also creates empty sales/reconciliation relations and the
PostGIS/location columns needed by the shared custom/UAD market and neighborhood
services; no source sale rows are copied. The configured fixture account must
use the `UAD-REDTEAM-` namespace. Static checks do not prove cloud credential
scope, so independently inspect the R2 token policy, Render resource links, and
OIDC application before opening a test window.

### Deterministic authorization-test issuer

Authenticated authorization testing may use `REDTEAM_OIDC_PROVIDER=static_redteam`
instead of a human-login provider. This mode exists only for the disposable,
synthetic red-team service. The issuer hostname must contain `red team` and end
in the reserved `.invalid` top-level domain, the audience must contain
`red team`, and the HTTPS JWKS URL must itself carry a red-team marker. Startup
rejects an unknown provider or a production-shaped issuer.

Publish only the RSA public JWK. Keep the matching 2048-bit-or-stronger private
key in the GitHub `uad-redteam` environment secret
`UAD_REDTEAM_JWT_PRIVATE_KEY`; never add it to Render, R2, source control, or a
test artifact. Store the synthetic subject map in
`UAD_REDTEAM_OIDC_SUBJECTS_JSON`. The matrix runner creates ten-minute RS256
tokens in memory, never prints them, and uses an intentionally invalid revision
probe to prove write authorization after middleware without changing a
workfile. Rotate the key and public JWKS after a test program or suspected
exposure.

### WorkOS AuthKit boundary

WorkOS applications in one WorkOS environment share the environment issuer,
but each application receives a unique generated client ID. WorkOS access
tokens use that client ID as their audience, so the literal audience cannot be
named `redteam`. For a WorkOS-backed red-team deployment, set all of:

- `REDTEAM_OIDC_PROVIDER=workos_authkit`;
- `REDTEAM_OIDC_APPLICATION_ID` to the dedicated application's generated
  `app_...` identifier;
- `REDTEAM_OIDC_APPLICATION_NAME` to a dashboard-verified name containing
  `red team` (separators are allowed);
- `REDTEAM_OIDC_CLIENT_ID` and `OIDC_AUDIENCE` to the same dedicated generated
  `client_...` identifier; and
- `OIDC_JWKS_URI` to `/oauth2/jwks` on the exact `OIDC_ISSUER` origin.

The startup guard rejects a partial WorkOS configuration, a client/audience
mismatch, or a cross-origin/nonstandard JWKS endpoint. These static markers do
not verify WorkOS dashboard state: before each test window, inspect that the
application ID and client ID belong to the named red-team application. Do not
modify a shared WorkOS environment JWT template to satisfy this guard because
that would change tokens issued to staging applications.

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

## Low-volume baseline

Before active scanning, manually dispatch `.github/workflows/uad-redteam-baseline.yml`.
The workflow has no target input: both Render origins and the synthetic fixture
namespace are compiled into the runner, so it cannot be redirected to staging,
production, or an attacker-controlled host. It sends eight bounded requests to
verify health/readiness, disabled external GSE providers, strict headers/CORS,
and generic missing/malformed-token rejection. The retained artifact contains
only status codes and boolean control results; access tokens and response bodies
are never written to evidence.

This baseline is not authorization to run load tests or broad fuzzing. Complete
the rules-of-engagement record, snapshot/restore exercise, monitoring checks,
and kill-switch rehearsal before any higher-intensity test window.

## Authenticated authorization matrix

After the baseline passes, manually dispatch
`.github/workflows/uad-redteam-authorization.yml`. The workflow is pinned to
the red-team API and fixture namespace and sends 73 sequential, bounded
requests. It verifies the assigned and unassigned appraisers, supervisor,
reviewer, both organization administrators, both tenants, HomeNode
administrator, inactive user, suspended membership, member without a role, and
an unprovisioned subject. Cross-tenant reads and writes must return 403;
reviewers must remain read-only. The uploaded evidence contains only status
codes, safe error codes, counts, and booleans—never access tokens, private keys,
response bodies, or user details.

Run locally only with the same environment variables used by the workflow:

```powershell
npm run --silent verify:redteam:authorization
```

Treat any failed matrix cell as a stop condition. Do not proceed to parser,
upload, concurrency, or active scanning tests until it is understood and the
matrix passes again.

## Bounded protocol fuzz

After the authenticated matrix passes, dispatch
`.github/workflows/uad-redteam-protocol-fuzz.yml`. The workflow is pinned to
the isolated API and sends 24 sequential requests. It rejects malformed,
corrupted, expired, not-yet-valid, wrong-issuer, wrong-audience, algorithm-
confusion, unknown-key, embedded-JWKS, missing-subject, and large malformed
tokens. It also exercises malformed, oversized, incorrectly compressed,
unsupported-charset, and non-JSON request bodies plus unknown routes and HTTP
method-override attempts.

Every tested rejection must return bounded JSON, and every tested UAD response
must carry `Cache-Control: no-store`. The runner reads at most 64 KiB, never
records tokens or response bodies, and fails if a response contains credential,
stack, SQL, or connection-string material.
It performs no valid mutation: the final recovery checks require health and
readiness to remain green and the protected synthetic workfile revision to be
unchanged. Run it locally only with the protected `uad-redteam` environment
variables:

```powershell
npm run --silent verify:redteam:protocol-fuzz
```

Treat any failed cell, changed fixture revision, unsafe response, or failed
recovery check as a stop condition before storage or concurrency testing.

## Bounded endpoint and input fuzz

After the recovery rehearsal passes, dispatch
`.github/workflows/uad-redteam-endpoint-fuzz.yml`. The workflow is pinned to the
isolated API and sends 22 bounded requests. It covers invalid, SQL-shaped,
Unicode, oversized, and control-character identifiers; encoded separators,
extra/doubled paths, unsupported resource methods, prototype-shaped and deeply
nested JSON, array and primitive roots, non-JSON bodies, forwarded-route header
confusion, hostile origins, and a bounded unknown header.

Every response is capped at 64 KiB and screened for tokens, private keys,
database URLs, SQL diagnostics, and unsafe error strings. The runner never
includes the attack values or response bodies in its evidence. It performs no
valid mutation and finishes by requiring health, readiness, and the protected
workfile revision to remain unchanged:

```powershell
npm run --silent verify:redteam:endpoint-fuzz
```

The local router regression suite separately proves that the application rate
limiter runs before JSON parsing, so repeated malformed bodies receive the same
bounded `429 rate_limit_exceeded` response as ordinary request bursts.

## Bounded load and rate-limit recovery

Dispatch `.github/workflows/uad-redteam-bounded-load.yml` only after the
endpoint gate passes and monitoring is visible. The runner reads the advertised
application limit, refuses to run if it is absent, below 10, or above 200, and
uses at most six workers against the public capabilities endpoint. It stops
scheduling when the first bounded `429 rate_limit_exceeded` response arrives.
Because hosted CI can legitimately rotate across public egress addresses, the
runner recognizes at most four advertised policy buckets and retains a hard
500-request ceiling. It records aggregate bucket/latency/status counts only and
never retains policy keys or response bodies.

The runner waits for the server-advertised `Retry-After` interval (capped at 70
seconds), then requires capabilities and readiness to return 200 again. Any
5xx, redirect, unsafe/unbounded response, missing rate-limit header, missing
429, excessive advertised limit, or failed recovery is a stop condition:

```powershell
npm run --silent verify:redteam:bounded-load
```

## Integrity and private-storage checks

After the authenticated matrix passes, dispatch
`.github/workflows/uad-redteam-integrity.yml`. It remains fixed to the isolated
service and runs a small, deterministic set of adversarial checks:

- two simultaneous saves with one expected revision, requiring exactly one
  success and one `409 uad_section_stale_revision`;
- malformed, oversized, and deeply nested JSON, requiring bounded JSON errors;
- cross-tenant, invalid-type, and invalid-size upload requests;
- path traversal in an original filename, requiring an organization/workfile
  scoped sanitized object key;
- a content-type signature mismatch, requiring R2 to reject the PUT;
- a valid small synthetic PNG upload, verification, listing, and deletion; and
- a byte-size mismatch, requiring rejection and cleanup.

The runner restores the original synthetic commentary after its revision race
and deletes every asset record and R2 object it creates, including rejected or
partially uploaded objects. Before creating an object, it also removes only
prior assets carrying the synthetic red-team marker and one of its fixed probe
filenames. R2 presigned URLs use Cloudflare's documented virtual-host form
(`<bucket>.<account>.r2.cloudflarestorage.com`). The workflow enables shell
pipeline failure propagation so a failed verifier cannot be hidden by evidence
capture through `tee`. The evidence contains only status codes, counts,
booleans, and safe error codes; it excludes presigned URLs, object keys, access
tokens, private keys, request bodies, and response bodies. Treat a failed
cleanup control as a stop condition and inspect the isolated bucket before
another run.

## Recovery rehearsal

Create a logical export from the isolated Render database, then perform a
point-in-time recovery into a disposable database whose name includes
`redteam`. Copy its external URL only into the temporary
`REDTEAM_RECOVERY_DATABASE_URL` environment variable and set
`REDTEAM_RECOVERY_DATABASE_SERVICE_ID` to the restored Render database ID. Run
`npm run verify:redteam:recovery` from `server/`. The verifier refuses the
primary database, enforces the restored service identity, checks that every
protected row remains synthetic, validates all UAD migration checksums, and
requires the exact synthetic fixture counts without printing the connection
URL. Preserve its credential-free JSON result, then delete the disposable
recovery database.

Red-team startup reconciles each deterministic persona to the currently active
isolated issuer and removes identities left by a retired red-team issuer. If an
older recovery point contains those stale synthetic identities, run the guarded
startup-equivalent reconciliation only against the disposable recovery copy:

```powershell
$env:REDTEAM_RECOVERY_ALLOW_IDENTITY_PRUNE = "true"
$env:REDTEAM_RECOVERY_OIDC_ISSUER = "https://the-active-red-team-issuer.example"
npm run --silent reconcile:redteam:recovery-identities
```

The command requires the same recovery URL and Render service-ID boundary,
checks the synthetic-only database first, refuses an incomplete active persona
set, prunes only retired-issuer mappings for the eleven deterministic persona
IDs, and reruns the complete recovery verifier in the same process. Clear all
temporary variables and remove the copied recovery URL immediately afterward.

## Kill conditions

Disable `UAD_WORKSPACE_ENABLED`, block the test source at Cloudflare, and revoke
the red-team R2/OIDC credentials if any stop condition in the security program
occurs. Do not delete the database or bucket until evidence has been preserved
and the incident owner confirms that no real data or external system was
reached.

The red-team startup boundary requires `UAD_WORKSPACE_ENABLED` to be explicitly
set, but accepts `false` as the fail-closed state. The service therefore remains
healthy enough to expose `/api/uad/capabilities` and `/api/uad/readiness` while
all UAD workfile routes return `503 uad_workspace_disabled`. Re-enable the
workspace only after the stop condition is resolved and the low-volume baseline
passes again.

During a scheduled rehearsal, set only the isolated API's
`UAD_WORKSPACE_ENABLED=false`, wait for its deployment to become live, and
dispatch `.github/workflows/uad-redteam-kill-switch.yml`. Its five requests
require health to remain green, capabilities to report `enabled=false`,
readiness to degrade specifically on `uad_workspace_disabled`, and both a
protected read and write to return the same bounded 503 without reaching
authentication or persistence. Restore the flag to `true`, wait for deployment,
then rerun baseline and endpoint fuzz before closing the exercise.

## Sales-rich delivery gate

Protocol security results do not establish appraisal completeness. The
separate `.github/workflows/uad-successful-delivery.yml` gate prepares a fresh
synthetic PostgreSQL database and requires three settled comparable sales,
verified comparable photos, nonzero adjustments, recalculated adjusted prices,
comparable weighting, sales reconciliation, a final opinion, schema-valid
MISMO XML, a rendered native PDF, and a deterministic ZIP. Its negative cases
must also prove that a fixture without sales, adjustments, or reconciliation is
rejected. This gate runs on relevant pull requests and every relevant push to
`main`; it does not call a Fannie Mae or Freddie Mac system without their
nonproduction credentials.
