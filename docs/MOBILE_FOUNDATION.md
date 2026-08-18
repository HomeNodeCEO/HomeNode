# HomeNode mobile inspection foundation

Status: Phase 6 field foundation. Offline synchronization, private photo capture,
the Custom Appraisal review adapter, and the manual sketch workspace are built.
The mobile API remains disabled by default and no identity-provider purchase or
production migration is part of this work.

## Boundaries

The mobile application is a field companion to the existing HomeNode system,
not a fourth appraisal system. PostgreSQL remains authoritative and the three
canonical workflows stay separate:

- Custom Appraisal continues to use `app.assignment_files`.
- UAD 3.6 continues to use `appraisal.uad_workfiles` and its UAD-specific rules.
- Property Tax Protest receives `app.tax_protest_files` and its own lifecycle.

`app.report_files` is a typed registry over those three targets. Its database
constraint requires exactly the target that matches the workflow type; it does
not combine their domain data. `app.inspection_sessions` supplies the common
mobile lifecycle and organization/appraiser boundary.

## File identity and version safety

Each organization, workflow, and calendar year has an atomic sequence:

- `HN-CA-2026-000001`
- `HN-UAD-2026-000001`
- `HN-PTP-2026-000001`

Creating a later report for the same property creates a new canonical file and
links `previous_report_file_id`. The prior row remains available and becomes
non-current; it is never reused or replaced. A caller-supplied UUID makes the
creation request idempotent, so a retry returns the original result rather than
allocating a duplicate number.

The discovery API returns all accessible files, marks recently changed files,
and recommends an existing current file before creation. Legacy rows without an
organization remain visible only to a HomeNode administrator and cannot start
an inspection until explicitly assigned; the API does not guess ownership.

Mobile edits are sparse records in `app.inspection_field_edits`. Only a field
the appraiser explicitly submits can later be applied. Each edit retains its
base value, entered value, author, source, session revision, and conflict state.
`app.mobile_sync_operations` supplies operation-level idempotency. Applying
those staged edits to the three canonical domains is intentionally a later
adapter phase, with optimistic conflict checks rather than last-write-wins.

## Authentication

The API accepts OIDC access tokens and verifies RS256 signatures using the
provider's HTTPS discovery/JWKS endpoints. The mobile client never receives a
client secret or database credential. An `(issuer, subject)` pair must be
explicitly mapped to an active `app_auth.users` row, and an active organization
membership plus an allowed role is required for writes. There is no automatic
user provisioning.

Required environment settings after provider approval:

```text
MOBILE_INSPECTION_ENABLED=true
OIDC_ISSUER=https://provider-issuer.example
OIDC_AUDIENCE=https://api.homenode.com/mobile
OIDC_JWKS_URI=                     # optional when discovery publishes jwks_uri
OIDC_CLOCK_TOLERANCE_SECONDS=60
```

The contract is intentionally provider-neutral. Expo/React Native should use
Authorization Code with PKCE and secure OS credential storage; no reusable
secret belongs in the app bundle.

## Managed OIDC cost decision

Pricing checked against official provider pages on 2026-08-17:

| Provider | Practical HomeNode starting cost | Material tradeoff |
| --- | ---: | --- |
| WorkOS AuthKit | $0/month through 1 million MAU | MFA and RBAC are included. A custom auth domain is $99/month; enterprise SSO connections are $125/month each. |
| Auth0 | $0/month through 25,000 MAU; Essentials starts at $35/month for 500 MAU | Mature Expo support, but the paid floor arrives sooner. |
| Clerk | $0/month through 50,000 retained users; Pro is $20/month annually or $25 month-to-month | Expo support is strong, but MFA requires Pro. |
| Amazon Cognito | Usage-based with a free allowance | Potentially inexpensive, but materially more AWS configuration and operational surface for this small internal app. |

Recommendation: approve WorkOS AuthKit at the $0 tier. It provides the best
cost-to-security fit for HomeNode's small internal user population because MFA
and RBAC do not force an immediate paid plan. Keep its hosted auth domain at
first, so the expected provider bill is $0. A custom domain or enterprise SSO
must be a separate approval.

Official pricing references:

- <https://workos.com/pricing>
- <https://auth0.com/pricing?pm=true>
- <https://clerk.com/pricing>
- <https://aws.amazon.com/cognito/pricing/>

## Manual sketch workspace

`POST /api/mobile/sketches/calculate` accepts a measured outline in feet. It
checks closure within a bounded tolerance, rejects self-intersecting outlines,
and calculates perimeter and square feet only for a valid closed polygon.

The mobile workspace now persists multiple measured areas, classifications,
room markers, appraiser confirmation, revisions, and audit history. Drafts save
to encrypted SQLite and synchronize independently from sparse property edits.
Room references produce automatic photo labels; renaming a room updates only
room-generated photo captions and preserves manual captions. See
`docs/MOBILE_MANUAL_SKETCH.md` for the complete boundary and workflow.

Geometric closure alone does not establish ANSI eligibility. Above/below-grade
status, ceiling-height treatment, access, finish, declarations, and any required
alternate standard remain subject to documented appraiser review.

LiDAR is deliberately reported as unavailable in this phase. The structured
geometry contract allows a future LiDAR source without making LiDAR-derived
measurements authoritative by default.

## Photo and appraisal-file retention

Appraisal evidence is retained in a verified appraisal-file archive for five
years. `app.report_file_archives` records the checksum, object reference,
archive revision, verification time, retention period, and legal hold. A
working/device copy may be deleted immediately only after the archive is
verified and the deletion is recorded in `app.report_retention_events`.

Cloudflare R2 remains private. Mobile upload will reuse the existing pattern:
request a short-lived upload URL, upload directly, then ask HomeNode to verify
the object. R2 credentials never reach the phone. Empty photo placeholders
should be local UI slots, not stored objects; bulk capture will create assets
only for actual files and will be capped at 100 per operation.

## Internal distribution

Recommended production path:

- iOS: Apple Business Manager Custom App distribution under the Apple Developer
  Program ($99/year). TestFlight is suitable for beta builds, not permanent
  production distribution. An unlisted App Store app is the fallback for
  unmanaged devices, but possession of its link is not an authorization control.
- Android: Managed Google Play private app when HomeNode uses an EMM. Otherwise,
  use a Play organization account/internal track; the registration fee is $25
  one time. Direct sideloading is acceptable for device testing, not the durable
  update and security channel.

Official distribution references:

- <https://developer.apple.com/programs/enroll/>
- <https://developer.apple.com/support/volume-purchase-and-custom-apps/>
- <https://developer.apple.com/support/unlisted-app-distribution/>
- <https://support.google.com/googleplay/android-developer/answer/6112435>
- <https://support.google.com/googleplay/work/answer/9146439>

## API surface in this phase

- `GET /api/mobile/capabilities` — deployment/auth/workflow capability flags.
- `GET /api/mobile/me` — resolved HomeNode user, organizations, and roles.
- `GET /api/mobile/report-files` — discover current/recent/prior typed files.
- `POST /api/mobile/report-files` — idempotently create a new versioned file.
- `POST /api/mobile/inspection-sessions` — resume or create one active session.
- `GET /api/mobile/inspection-sessions/:id` — retrieve an owned session.
- `GET /api/mobile/inspection-sessions/:id/sketch` — retrieve its current sketch
  and active room markers.
- `PUT /api/mobile/inspection-sessions/:id/sketch` — idempotently save a
  revision-checked full manual sketch.
- `POST /api/mobile/sketches/calculate` — validate closure and calculate area.

Run UAD migrations first, then `npm run migrate:mobile`. The new API stays dark
until the migration, identity provisioning, and `MOBILE_INSPECTION_ENABLED=true`
are deliberately deployed.

## Next phases

1. Approve and configure managed OIDC; the provider-neutral Expo PKCE and server
   verification paths are ready but intentionally inactive.
2. Complete report-ready sketch rendering plus desktop geometry/relabel/reorder
   review tools.
3. Add the separate UAD 3.6 and Property Tax Protest field adapters without
   changing their canonical workflows.
4. Run physical-device staging across iPhone and Android, including offline and
   100-photo inspections.
5. Add optional LiDAR capture after the manual workflow is field-tested.

Before production UAD delivery, separately confirm all required UAD compliance,
submission credentials, approved endpoints, and certification/testing status.
Those credentials must not be folded into the mobile OIDC configuration.
