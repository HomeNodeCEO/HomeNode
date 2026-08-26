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
- `WEB_APP_URL`

`OIDC_WEB_ISSUER` may fall back to the existing `OIDC_ISSUER`, but the web
application has its own confidential-client ID and audience. Merely configuring
these values does not show the login gate or remove editor-key access.

Provision the initial organization, memberships, and roles before activation.
Use `npm run provision:application-user` for provisioned OIDC identities and
`npm run migrate:legacy-appraisals:organization` for the controlled assignment
of legacy Custom Appraisal files.

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
