# HomeNode managed OIDC activation

Status: implementation and staging guardrails are complete. WorkOS AuthKit is the selected provider; its external staging workspace and public OAuth application still require an authenticated WorkOS administrator.

## Cost decision

Pricing was rechecked against the providers' official pages on 2026-08-18.

| Provider | HomeNode starting cost | Decision factor |
| --- | ---: | --- |
| WorkOS AuthKit | $0/month through 1 million MAU | Includes MFA and RBAC; free staging; best security value for a small internal team. |
| Auth0 | $0/month through 25,000 MAU | Strong Expo support, but Pro MFA begins with the $35/month Essentials tier. |
| Clerk | $0/month through 50,000 retained users | Strong Expo support, but MFA requires Pro at $20/month annually or $25 month-to-month. |
| Amazon Cognito | Free allowance, then usage-based | Lower direct cost can be offset by materially more AWS configuration and operations. |

Use WorkOS's hosted AuthKit domain. Expected authentication cost is $0/month for HomeNode's internal population. A WorkOS payment method is required to unlock production even if usage remains within the free tier. Do not add billing, a $99/month custom domain, or paid enterprise connections as part of staging activation.

Official references:

- <https://workos.com/pricing>
- <https://workos.com/docs/authkit/environments>
- <https://workos.com/docs/authkit/connect/oauth>
- <https://auth0.com/pricing>
- <https://clerk.com/pricing>
- <https://aws.amazon.com/cognito/pricing/>

## Security boundary

- The mobile application is a public OAuth client. It uses Authorization Code with PKCE and contains no client secret.
- WorkOS must use a first-party Public OAuth application with `homenode://oauth/callback` as an exact redirect URI.
- Request only `openid profile email offline_access`.
- Disable public signup and use invitations only.
- Require TOTP MFA for non-SSO users.
- Store access and rotating refresh tokens only through `expo-secure-store`.
- The API accepts only RS256 tokens with the exact configured issuer and audience.
- For WorkOS public OAuth applications, `OIDC_AUDIENCE` is the application's public `client_id`.
- A verified token still grants no HomeNode access until `(issuer, sub)` is explicitly mapped to an active internal user with active organization membership.
- WorkOS roles do not replace HomeNode authorization. `app_auth.membership_roles` remains authoritative.

## Staging sequence

### 1. Create the WorkOS staging application

In the WorkOS staging environment:

1. Create a first-party OAuth application named `HomeNode Appraiser Staging`.
2. Mark it Public so token exchange requires PKCE and no client secret.
3. Add the exact redirect URI `homenode://oauth/callback`.
4. Allow `openid`, `profile`, `email`, and `offline_access`.
5. Disable the environment's public Sign up control.
6. Enable TOTP MFA.
7. Keep the WorkOS-hosted AuthKit domain; do not configure a paid custom domain.

Record only the non-secret AuthKit issuer and public OAuth `client_id`. Never copy an API key or client secret into the mobile project.

### 2. Configure the internal mobile build

Create ignored `homenode-mobile/.env.local` values:

```text
EXPO_PUBLIC_API_BASE_URL=https://homenode.onrender.com
EXPO_PUBLIC_OIDC_ISSUER=https://<environment>.authkit.app
EXPO_PUBLIC_OIDC_CLIENT_ID=client_<public-oauth-application-id>
```

`EXPO_PUBLIC_WORKOS_CLIENT_ID` remains a temporary compatibility alias for earlier builds. New builds must use `EXPO_PUBLIC_OIDC_CLIENT_ID`.

### 3. Configure Render without enabling access

Set these on `homenode-api-staging` while retaining `MOBILE_INSPECTION_ENABLED=false`:

```text
OIDC_ISSUER=https://<environment>.authkit.app
OIDC_AUDIENCE=client_<public-oauth-application-id>
OIDC_JWKS_URI=https://<environment>.authkit.app/oauth2/jwks
OIDC_CLOCK_TOLERANCE_SECONDS=60
MOBILE_INSPECTION_ENABLED=false
```

The staging start command runs `npm run verify:mobile-oidc`. When mobile access is disabled, it reports a safe skipped state. Once access is enabled, it must successfully fetch discovery/JWKS metadata and find at least one supported RS256 signing key or the deployment fails closed.

### 4. Link one staging identity

The guarded staging bootstrap creates only this synthetic HomeNode principal:

```text
HomeNode user: mobile-appraiser@staging.homenode.invalid
Role: appraiser
Profile policy: reauthentication
```

After an invited WorkOS staging user exists, copy its non-secret WorkOS user ID and run against `homenodedb-staging` only:

```powershell
cd server
npm run provision:mobile-identity -- --email mobile-appraiser@staging.homenode.invalid --issuer https://<environment>.authkit.app --subject user_123
```

The provisioning command refuses to reassign an existing `(issuer, subject)` to another HomeNode user. Do not run it against production `homenodedb` during this phase.

### 5. Enable and verify

Set `MOBILE_INSPECTION_ENABLED=true` on `homenode-api-staging`. A successful deploy must show:

1. UAD and mobile migrations are already applied or applied successfully.
2. The synthetic staging fixture is prepared.
3. OIDC preflight reports `configured: true`, the expected issuer/audience, `RS256`, and at least one supported key.
4. `GET /health` returns `200`.
5. `GET /api/mobile/capabilities` reports both mobile and authentication enabled/configured.
6. An unauthenticated protected request returns `401`, not `503`.
7. The invited mobile user can sign in and `GET /api/mobile/me` resolves the synthetic appraiser and staging organization.

If any step fails, set `MOBILE_INSPECTION_ENABLED=false`. This leaves UAD and web workflows operational while the identity configuration is corrected.

## Production boundary

Production activation is separate. It requires a WorkOS production environment, billing information, new production identifiers, separately invited real users, an approved internal distribution channel, and device testing. Never copy the synthetic staging principal or staging issuer/subject mapping into production.

Create a real internal appraiser and its OIDC mapping with the production-safe onboarding command. It is transactional, rejects synthetic `.invalid` users in production, refuses inactive or ambiguous records, and will not reassign an existing identity:

```powershell
cd server
npm run provision:mobile-user -- --email appraiser@example.com --display-name "Appraiser Name" --organization-legal-name "Example Appraisal Services, LLC" --organization-display-name "Example Appraisal" --organization-dba-name "Example Appraisal" --roles appraiser,organization_admin --issuer https://<environment>.authkit.app --subject user_123
```

UAD delivery credentials, submission endpoints, certification, and lender/GSE authorization remain independent from mobile OIDC and must be confirmed separately before production UAD submission.
