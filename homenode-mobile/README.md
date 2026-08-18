# HomeNode Appraiser mobile

Private Expo/React Native client for HomeNode field appraisal. Phase 2 provides managed OIDC sign-in, secure native session storage, HomeNode property search, existing-file discovery, safe creation of separate report versions, and inspection-session routing.

## WorkOS activation

Create a **first-party public OAuth application** in the WorkOS environment used by HomeNode:

1. Enable PKCE and do not create or embed a mobile client secret.
2. Register `homenode://oauth/callback` as the redirect URI.
3. Allow `openid profile email offline_access`.
4. Copy `.env.example` to `.env.local` and set the API URL, AuthKit issuer, and public OAuth client ID.
5. Configure the HomeNode server with:

   ```text
   MOBILE_INSPECTION_ENABLED=true
   OIDC_ISSUER=https://<environment>.authkit.app
   OIDC_AUDIENCE=<aud claim issued for the protected HomeNode API>
   OIDC_JWKS_URI=https://<environment>.authkit.app/oauth2/jwks
   ```

The issuer and audience must exactly match the WorkOS access token. The server remains provider-neutral and validates RS256 signatures, expiration, issuer, and audience before it performs HomeNode authorization.

After the WorkOS user exists, link its WorkOS user ID (`sub`) to one active HomeNode user:

```powershell
cd server
npm run provision:mobile-identity -- --email appraiser@example.com --issuer https://<environment>.authkit.app --subject user_123
```

This command refuses to silently move an identity already assigned to another user. HomeNode organization membership and roles remain the source of authorization.

## Local verification

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run doctor
```

Use a development build rather than Expo Go so the registered `homenode` callback scheme matches the WorkOS allowlist.

## Private installation

The `internal` EAS profile produces a directly installable Android APK. On iOS, internal/ad hoc distribution requires an Apple Developer account and registered devices; TestFlight is the alternative for private team testing and does not make the app publicly searchable. Public App Store release is not required for internal testing.

## Security boundary

- No WorkOS secret or server credential is present in the app.
- Access and rotating refresh tokens are stored separately with `expo-secure-store`.
- Property and report-file APIs require a verified bearer token and an active HomeNode organization membership.
- Creating a new assignment uses an idempotency UUID and creates a new numbered file linked to its predecessor. It never overwrites the prior report.
