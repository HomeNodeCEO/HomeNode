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

`OIDC_WEB_ISSUER` may fall back to the existing `OIDC_ISSUER`, but the web
application has its own confidential-client ID and audience. Merely configuring
these values does not show the login gate or remove editor-key access.

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

When enforcement is active, signing cannot use the shared editor key. The
server derives the signer from the authenticated assignment, records an
immutable signature event with organization/user/request attribution, and
authenticates the snapshot checksum with `APP_SIGNING_SECRET`. Signed Custom
Appraisal snapshots are append-only at the database trigger layer. HMAC-backed
snapshots are re-verified before JSON download or PDF rendering and fail closed
if either the stored snapshot or its authentication value has changed.

The shared editor key remains a temporary migration path. Retire it only after
all expected users can log in and access the correct organization files.

## Storage remains independent

Authentication rollout does not redirect Custom Appraisal documents or shared
mobile photos. Those continue to use `R2_*`. UAD can independently use:

- `UAD_R2_ACCOUNT_ID`
- `UAD_R2_ACCESS_KEY_ID`
- `UAD_R2_SECRET_ACCESS_KEY`
- `UAD_R2_BUCKET`

Unset UAD overrides fall back to the shared R2 configuration. Do not activate a
dedicated UAD bucket until the credential-safe object-storage probe succeeds.
