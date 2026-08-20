# HomeNode Appraiser mobile

Private Expo/React Native client for HomeNode field appraisal. Phase 11 includes
offline sparse inspection fields, private photos, manual measurement and room
labels, separate reviewed adapters for all three canonical report types,
repeatable UAD property-component proposals, and a guarded finish-on-site
readiness workflow.

## Offline inspection behavior

- Inspection context and sparse field drafts persist across application restarts in SQLCipher-encrypted SQLite.
- The database key is generated on the device and stored with `expo-secure-store`; cached work is scoped to the last authenticated HomeNode user and is not deleted merely because connectivity is unavailable.
- Every edit receives a client UUID and SHA-256 payload digest. The API applies it once, returns the prior result on safe retry, and rejects reuse of the UUID with different content.
- Queued work retries when connectivity returns, when the app becomes active, and on a bounded exponential-backoff timer.
- A stale edit is automatically rebased only when its recorded field-level base still matches HomeNode. A different server value becomes an explicit conflict with **Use HomeNode value** and **Keep mobile value** actions.
- Custom Appraisal observations synchronize separately, then require per-field **Accept into this appraisal file** or **Keep inspection-only** review. Acceptance uses an exact-value conflict check and never mutates the property-wide manual record.

## Custom Appraisal field review

- Property fields are grouped into Basics, Exterior, Interior, Systems & Amenities, and Condition & Repairs rather than presented as one oversized form.
- Structured values and explicit clears save to encrypted SQLite first and use the existing durable operation queue.
- The server maps only allowlisted field paths. Unmapped inspection data cannot reach a report target.
- Accepted fields update only the selected assignment file, create audit/version history, and increment its report-file registry revision.
- A same-field report change becomes a visible conflict; unrelated report changes remain untouched.
- The latest field catalog and review snapshot are cached so an already-opened assignment remains usable offline. Final report acceptance requires a connection to authoritative PostgreSQL.
- The Custom Appraisal review also shows the count of verified photos attached to that exact report file.

## UAD 3.6 and Property Tax Protest review

- The app loads a target-specific catalog only after an existing typed report
  file and inspection session are selected.
- UAD inputs use the locked official HomeNode field catalog and existing
  workfile entities. Property Tax Protest uses its own bounded field catalog.
- The catalog, canonical values, target revision, and proposal review state are
  cached for offline use.
- Each queued edit retains the canonical value/revision visible when the form
  opened. Acceptance refuses to overwrite a same-field desktop change.
- **Accept into report** appends the target's domain history and registry audit;
  **Keep inspection-only** leaves the report unchanged.
- Official repeatable UAD records—including levels, rooms, interior/exterior
  defects, outbuildings, vehicle storage, amenities, site details, and market
  trend sources—can be queued offline and explicitly accepted into the report.
- Comparable creation and repeatable comparable children follow the canonical
  web UAD catalog and the same explicit acceptance workflow. UAD submission
  credentials and certification remain outside mobile authentication.

See `docs/MOBILE_TARGET_FIELD_ADAPTERS.md` for the full persistence and API
boundary and `docs/MOBILE_UAD_REPEATABLE_ENTITIES.md` for entity review.

SQLCipher requires a development or internal native build and is not available in Expo Go.

## Manual sketch and room labels

- Enter wall length and bearing to draw multiple closed property areas without LiDAR.
- Dimensions use 0.1-foot field precision; valid closed polygons calculate perimeter and reported whole-square-foot area.
- Above-grade, below-grade, nonstandard, noncontinuous, unfinished, garage, porch, patio, deck, outbuilding, and other areas remain separate.
- Sketch drafts use their own encrypted SQLite queue, optimistic revision, idempotency UUID, retry/backoff, and explicit conflict choices.
- Room markers have stable references. Selecting a room makes it the automatic label for new photos, and room-generated captions follow later room renames while manual captions remain unchanged.
- Appraiser confirmation is explicit. Polygon closure never substitutes for grade, finish, ceiling-height, access, declaration, or other professional review.

The server stores every sketch revision and audit event on the existing typed report file. See `docs/MOBILE_MANUAL_SKETCH.md` for the API and data boundary.

## Photo capture and retention

- Camera captures and as many as 100 library selections per inspection are copied into app-private durable storage before the picker cache can be cleared.
- Selecting a room produces an automatic room label; the appraiser can instead choose a report category and can edit the caption under every image.
- Every photo receives client-generated photo/object IDs. Retrying registration returns the same server record rather than creating a duplicate.
- Originals are preserved. A browser-compatible JPEG display derivative is created on-device, including for HEIC/HEIF originals.
- The encrypted SQLite queue restores interrupted registration, upload, and verification work after restart and retries with bounded exponential backoff.
- The mobile client uploads directly to short-lived, object-specific R2 URLs. R2 credentials never reach the device, and a photo is not synchronized until the backend verifies every object with `HEAD`.
- Empty local placeholders can be removed immediately. Removing a verified photo excludes it from the active report but retains its private objects and audit record for five years.

## Finish inspection on site

- HomeNode synchronizes and checks every local edit, conflict, photo, sketch,
  workflow proposal, and UAD entity proposal before enabling completion.
- The final request is online-only, revision-guarded, idempotent, and recorded
  in both inspection-session and report-file audit history.
- Completion makes the mobile session read-only. It does not sign, certify,
  transmit, or submit the appraisal report.
- A saved sketch must be appraiser-confirmed. No saved sketch is disclosed for
  later report validation rather than being falsely treated as complete.

See `docs/MOBILE_INSPECTION_COMPLETION.md` for the server checks and lifecycle.

## WorkOS activation

Create a **first-party public OAuth application** in the WorkOS staging environment used by HomeNode:

1. Mark the application Public, require PKCE, and never create or embed a mobile client secret.
2. Register `homenode://oauth/callback` as the redirect URI.
3. Allow `openid profile email offline_access`.
4. Disable public sign-up and require TOTP MFA before inviting a test user.
5. Copy `.env.example` to `.env.local` and set:

   ```text
   EXPO_PUBLIC_API_BASE_URL=https://homenode.onrender.com
   EXPO_PUBLIC_OIDC_ISSUER=https://<environment>.authkit.app
   EXPO_PUBLIC_OIDC_CLIENT_ID=client_<public-oauth-application-id>
   ```

6. Configure Render staging, initially leaving the protected routes dark:

   ```text
   MOBILE_INSPECTION_ENABLED=false
   OIDC_ISSUER=https://<environment>.authkit.app
   OIDC_AUDIENCE=client_<public-oauth-application-id>
   OIDC_JWKS_URI=https://<environment>.authkit.app/oauth2/jwks
   ```

The issuer and audience must exactly match the WorkOS access token. WorkOS public OAuth access tokens use the application `client_id` as `aud`. The server remains provider-neutral and validates RS256 signatures, expiration, issuer, and audience before it performs HomeNode authorization.

After the WorkOS staging user exists, link its WorkOS user ID (`sub`) to the synthetic HomeNode staging appraiser:

```powershell
cd server
npm run provision:mobile-identity -- --email mobile-appraiser@staging.homenode.invalid --issuer https://<environment>.authkit.app --subject user_123
```

The command refuses to silently move an identity already assigned to another user. HomeNode organization membership and roles remain the source of authorization. Set `MOBILE_INSPECTION_ENABLED=true` only after the mapping exists; Render then performs OIDC discovery and JWKS preflight before replacing the live deployment. See `docs/MOBILE_OIDC_ACTIVATION.md` for the complete checklist.

## Local verification

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run doctor
```

Use a development build rather than Expo Go so the registered `homenode` callback scheme matches the WorkOS allowlist and the SQLCipher-enabled database is compiled into the application.

## Private installation

The `internal` EAS profile produces a directly installable Android APK. On iOS, internal/ad hoc distribution requires an Apple Developer account and registered devices; TestFlight is the alternative for private team testing and does not make the app publicly searchable. Public App Store release is not required for internal testing.

## Security boundary

- No WorkOS secret or server credential is present in the app.
- Access and rotating refresh tokens are stored separately with `expo-secure-store`.
- Property and report-file APIs require a verified bearer token and an active HomeNode organization membership.
- Creating a new assignment uses an idempotency UUID and creates a new numbered file linked to its predecessor. It never overwrites the prior report.
- Offline field payloads are encrypted at rest and remain organization/user scoped when synchronized.
