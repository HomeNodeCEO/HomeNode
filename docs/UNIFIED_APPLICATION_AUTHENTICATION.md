# Unified HomeNode authentication rollout

HomeNode uses one canonical identity and organization model for UAD 3.6,
Custom Appraisal, Property Tax Protest, and the mobile inspection application.
The identity provider stores passwords and performs account recovery; PostgreSQL
stores HomeNode users, organization memberships, roles, assignments, sessions,
and audit relationships. Raw passwords are never stored by HomeNode.

## Additive database preparation

Run the application migration gate from `server`:

```text
npm run migrate:application
```

The command applies the checksummed UAD migrations first and then the
checksummed application/mobile migrations. The two authentication migrations
add organization ownership columns to Custom Appraisal files and add opaque web
sessions. They do not delete or rewrite existing appraisal, property, sales,
photo, document, or Property Tax data.

Production's Render pre-deploy command must use `npm run migrate:application`
before a release containing the unified-authentication code is started. The
migrations are advisory-locked and idempotent.

## Configuration stage

Configure these secret or environment values while leaving enforcement off:

- `OIDC_WEB_ISSUER`
- `OIDC_WEB_CLIENT_ID`
- `OIDC_WEB_CLIENT_SECRET`
- `OIDC_WEB_REDIRECT_URI`
- `APP_SESSION_SECRET` (at least 32 characters)
- `APP_SIGNING_SECRET` (a separate value of at least 32 characters)
- `WEB_APP_URL`

When the browser and API use different sites, as they do on the separate
`homenode-uad-staging.onrender.com` and `homenode-api-staging.onrender.com`
hosts, also configure:

- `WEB_SESSION_CROSS_SITE=true`
- `CORS_ORIGIN` containing the exact HTTPS origin from `WEB_APP_URL`

Cross-site mode applies `SameSite=None` only to the opaque application session
cookie. The authorization transaction cookie remains `SameSite=Lax`, and both
cookies remain `Secure`, `HttpOnly`, host-only `__Host-` cookies. Every unsafe
cookie-authenticated request must include an `Origin` exactly matching
`WEB_APP_URL`; missing or mismatched origins fail before database access. The
server refuses to start cross-site mode without an HTTPS application URL and
its exact CORS allowlist entry. Prefer leaving this mode off when the frontend
and API are served from the same site.

`OIDC_WEB_ISSUER` may fall back to the existing `OIDC_ISSUER`, but the web
application has its own confidential-client ID and audience. Merely configuring
these values does not show the login gate or disable editor-key access; explicit
activation does both.

Production must always declare its authentication mode explicitly. During the
temporary preparation stage, set both values below and choose a reviewed future
UTC date for the rollout deadline:

```text
APPLICATION_AUTHENTICATION_REQUIRED=false
LEGACY_AUTH_ROLLOUT_UNTIL=YYYY-MM-DD
```

Production startup rejects a missing, blank, or non-literal authentication
value. Only the exact lowercase strings `true` and `false` are accepted. A
production `false` value also fails startup when the rollout date is missing,
malformed, today, or in the past. Development and tests retain the historical
default when the setting is absent.

Valid rollout mode remains ready so an approved migration window does not take
desktop or mobile synchronization offline. `/ready` exposes only stable
`legacy_auth_rollout_*` warning codes and no configured values; monitoring must
alert on the active, expiring, or expired posture. A process that crosses the
deadline continues serving until its next restart or deployment, when startup
fails closed. Extend the deadline only through a reviewed configuration change.

The browser authorization-code flow uses state, PKCE, and a signed,
short-lived transaction cookie. HomeNode verifies the returned OpenID Connect
ID token against the web client ID and requires its nonce to match that signed
transaction before looking up a HomeNode identity or creating a session. The
provider access token is not used as the browser identity assertion and is not
stored by HomeNode.

Provision the initial organization, memberships, and roles before activation.
Use `npm run provision:application-user` for provisioned OIDC identities and
`npm run migrate:legacy-appraisals:organization` for the controlled assignment
of legacy Custom Appraisal files.

The rollout is deliberately split into reversible inspection and explicit
application steps:

```text
npm run audit:application-auth-rollout -- --organization-legal-name "Example Appraisal Services, LLC"

npm run bootstrap:application-organization -- \
  --email appraiser@example.com \
  --display-name "Example Appraiser" \
  --organization-legal-name "Example Appraisal Services, LLC" \
  --organization-display-name "Example Appraisal" \
  --roles appraiser,organization_admin \
  --signature-policy session
```

Both commands above are read-only: the bootstrap runs inside a transaction and
rolls it back unless `--apply` is present. In production, an applying bootstrap
also requires `--confirm-production` to exactly match the legal name. The
bootstrap creates the internal organization, user, membership, roles, optional
license, and appraiser profile without inventing an identity-provider subject.
Re-running it can explicitly maintain either the `session` or `reauthentication`
signature policy.

After the confidential WorkOS application and user exist, map the exact WorkOS
issuer/subject with `npm run provision:application-user` or
`npm run provision:mobile-identity`. Never derive or guess an OIDC subject from
an email address.

Run the legacy ownership command without `--apply` first. Record every value in
`pending_before`, then supply those exact values during application. The guarded
transaction covers Custom Appraisal and UAD workfile ownership, missing canonical
report registry rows, and missing appraisal-case subject snapshots. Production
also requires the exact legal-name confirmation:

```text
npm run migrate:legacy-appraisals:organization -- \
  --organization-legal-name "Example Appraisal Services, LLC" \
  --assigned-appraiser-email appraiser@example.com

npm run migrate:legacy-appraisals:organization -- \
  --organization-legal-name "Example Appraisal Services, LLC" \
  --assigned-appraiser-email appraiser@example.com \
  --expected-assignment-files 123 \
  --expected-uad-workfiles 12 \
  --expected-custom-registry-gaps 0 \
  --expected-uad-registry-gaps 1 \
  --expected-history-gaps 1 \
  --confirm-production "Example Appraisal Services, LLC" \
  --apply
```

The applying command refuses to run if any count changed after the dry run. It
adds ownership to legacy Custom and UAD targets, repairs their canonical report
registry and appraisal-history links, and captures missing immutable subject
snapshots. It does not rewrite appraisal observations, sales, adjustments,
photos, documents, UAD revisions, or signed snapshots.

Authenticated mobile discovery and replication never expose organization-less
legacy files. Previous Appraisal Files, completion snapshots, photos, and
documents are additionally checked against the canonical assignment and
assignee. Legacy property-level documents that are not attached to an owned
assignment fail closed and appear in the rollout audit for manual disposition.
When mandatory authentication is activated, one fail-closed gate also covers
the remaining legacy property, search, enrichment, and report API surface so a
missed handler-specific guard cannot expose application data.

## Activation stage

After staging login, logout, organization isolation, assigned-file access, and
signing tests pass, set:

```text
APPLICATION_AUTHENTICATION_REQUIRED=true
```

This single activation flag protects the browser application and UAD routes.
Startup fails closed if the confidential web client, callback, application URL,
or session secret is incomplete. The frontend reads both `configured` and
`required` from `/api/auth/status`, so pre-provisioning WorkOS cannot
accidentally lock the existing application.

Do not enable the flag until `audit:application-auth-rollout` reports
`activation_ready: true`. That requires a mapped OIDC identity, active
membership, active appraiser profile, non-expired active license, complete
file/appraiser ownership and canonical report/history coverage, no cross-table
organization mismatches, and no unattached legacy document evidence.

After enabling authentication in staging, run the credential-free public gate:

```text
APPLICATION_AUTH_STAGING_BASE_URL=https://homenode-api-staging.onrender.com \
  npm run verify:staging:application-auth -- --public-only
```

It requires healthy runtime and OIDC configuration, mandatory browser/UAD
authentication, native mobile bearer configuration, anonymous `401` responses,
and an inert legacy editor key. It performs only `GET` requests.

Then run `.github/workflows/application-auth-staging-matrix.yml` with a single
organization-A account that contains owned Custom Appraisal, UAD 3.6, and
Property Tax fixtures. Configure the protected `application-auth-staging`
environment with these non-secret variables:

- `APPLICATION_AUTH_STAGING_ORG_A_ID`
- `APPLICATION_AUTH_STAGING_ORG_B_ID`

Configure these environment secrets immediately before the run with distinct,
short-lived staging access tokens, and delete or replace them after the run:

- `APPLICATION_AUTH_STAGING_ORG_A_TOKEN` for an organization-A administrator
- `APPLICATION_AUTH_STAGING_ORG_B_TOKEN` for a writable organization-B user

The workflow inputs provide the shared account ID plus the organization-A
Custom assignment numeric ID, UAD workfile UUID, and Property Tax file UUID.
The matrix confirms the two session memberships are distinct, requires the
server readiness audit to return `activation_ready: true`, exercises positive
read access, demands anonymous `401` and cross-organization `403` responses for
read/write/upload/sign boundaries, and proves mobile discovery includes all
three organization-A targets for A and none for B. Denial probes use only B or
anonymous credentials plus payloads that are deliberately invalid negative
controls, so even a failed authorization assertion cannot alter fixture data.
They must still be rejected by authentication before validation runs. The
tool emits status codes and stable error codes only; it never emits tokens,
fixture identifiers, response bodies, or raw network diagnostics.

Property Tax activation additionally requires every protest target to have one
canonical report-file row, a current history revision whose status and JSON
match the live protest file, and authenticated desktop-save events with a
non-null server-derived actor. Desktop protest updates may change only the
server allowlist of reviewed case, subject, valuation, analysis, inspection,
and comparable-grid fields. Unknown legacy fields remain stored unchanged;
clients cannot create, alter, or delete unknown paths through the generic JSON
save endpoint.

When enforcement is active, no application route can use the shared editor key.
The server derives the signer from the authenticated assignment, records an
immutable signature event with organization/user/request attribution, and
authenticates the snapshot checksum with `APP_SIGNING_SECRET`. Signed Custom
Appraisal snapshots are append-only at the database trigger layer. HMAC-backed
snapshots are re-verified before JSON download or PDF rendering and fail closed
if either the stored snapshot or its authentication value has changed.

The shared editor key remains a temporary migration path only while enforcement
is disabled. After all expected users can log in and access the correct
organization files, activate mandatory authentication; the stored key then
becomes inert and may be removed from the hosting environment separately.

After private workflows activate mandatory authentication, rollback may use
only a previous authentication-enforcing release or maintenance mode. Never
restore `APPLICATION_AUTHENTICATION_REQUIRED=false` as an incident rollback.

## Storage remains independent

Authentication rollout does not redirect Custom Appraisal documents or shared
mobile photos. Those continue to use `R2_*`. UAD can independently use:

- `UAD_R2_ACCOUNT_ID`
- `UAD_R2_ACCESS_KEY_ID`
- `UAD_R2_SECRET_ACCESS_KEY`
- `UAD_R2_BUCKET`

Unset UAD overrides fall back to the shared R2 configuration. Do not activate a
dedicated UAD bucket until the credential-safe object-storage probe succeeds.
