# HomeNode mobile inspection foundation

Status: Phase 11 inspection-completion foundation. Offline synchronization,
private photo capture, manual sketching, reviewed adapters for all three report
types, repeatable UAD entities, provider-neutral Expo PKCE, deployment OIDC
preflight, and guarded finish-on-site readiness are built. The mobile API
remains disabled by default; WorkOS activation and production migration remain
separate deployment decisions.

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
`app.mobile_sync_operations` supplies operation-level idempotency. Custom
Appraisal, UAD 3.6, and Property Tax Protest each have an allowlisted adapter
into their own canonical target. A synchronized observation remains
inspection-only until explicit acceptance. The adapter compares the exact
canonical field value captured on the device, creates domain and registry
history, and refuses a stale same-field overwrite.

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
OIDC_AUDIENCE=<expected access-token audience>
OIDC_JWKS_URI=                     # optional when discovery publishes jwks_uri
OIDC_CLOCK_TOLERANCE_SECONDS=60
```

For the selected WorkOS public OAuth application, the issuer is its AuthKit
domain, the audience is the public application's `client_id`, and the JWKS is
`https://<authkit-domain>/oauth2/jwks`. Render staging runs an OIDC discovery
and supported-key preflight whenever mobile inspection is enabled; an invalid or
unreachable identity configuration fails the new deployment while the previous
healthy deployment remains live.

The contract is intentionally provider-neutral. Expo/React Native should use
Authorization Code with PKCE and secure OS credential storage; no reusable
secret belongs in the app bundle.

## Managed OIDC cost decision

Pricing rechecked against official provider pages on 2026-08-18:

| Provider | Practical HomeNode starting cost | Material tradeoff |
| --- | ---: | --- |
| WorkOS AuthKit | $0/month through 1 million MAU | MFA and RBAC are included. A custom auth domain is $99/month; enterprise SSO connections are $125/month each. |
| Auth0 | $0/month through 25,000 MAU; Essentials starts at $35/month for 500 MAU | Mature Expo support, but the paid floor arrives sooner. |
| Clerk | $0/month through 50,000 retained users; Pro is $20/month annually or $25 month-to-month | Expo support is strong, but MFA requires Pro. |
| Amazon Cognito | Usage-based with a free allowance | Potentially inexpensive, but materially more AWS configuration and operational surface for this small internal app. |

Decision: use WorkOS AuthKit, beginning in its free staging environment. It
provides the best cost-to-security fit for HomeNode's small internal user
population because MFA and RBAC do not force an immediate paid plan. Keep its
hosted auth domain, so the expected provider bill is $0. WorkOS requires a
payment method to unlock production even when AuthKit usage remains in the free
tier; adding it, a $99/month custom domain, or paid enterprise connections must
remain separate financial actions.

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

## UAD 3.6 and Property Tax Protest adapters

The shared mobile shell now loads a target-specific field catalog for those two
workflows. UAD fields come from the locked official HomeNode UAD catalog and are
scoped to the workfile's existing entities. Property Tax Protest uses a bounded
catalog stored in its versioned JSON workfile. Neither adapter writes to the
other workflow or to a property-wide override.

The phone records the canonical target value and target revision it observed.
Synchronization creates a proposal, not a report mutation. Accept and reject
are explicit, idempotent review operations. A same-field canonical change
creates a conflict; unrelated changes remain untouched. Accepted UAD values
append a UAD revision and audit event. Accepted protest values append protest
history and both adapters increment report registry history.

See `docs/MOBILE_TARGET_FIELD_ADAPTERS.md` for the API, persistence, desktop
review, and conflict boundary.

## Inspection completion

The mobile app now checks its encrypted device queues and the authoritative
server state before allowing **Finish inspection on site**. Pending edits,
conflicts, uploads, or workflow review proposals block completion. A saved
sketch also blocks until it is appraiser-confirmed; a missing sketch remains a
later report-validation concern rather than being silently treated as complete.

The idempotent completion transaction locks field capture, increments the
inspection-session revision, and records the actor and audit events. It does
not sign, submit, or change report content. See
`docs/MOBILE_INSPECTION_COMPLETION.md` for the complete lifecycle and API.

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
- `GET /api/mobile/inspection-sessions/:id/target-fields` — load the canonical
  target catalog, values, existing entities, verified-photo index, and proposals.
- `POST .../target-fields/proposals/refresh` — convert synchronized observations
  into target-specific review proposals.
- `POST .../target-fields/proposals/:proposalId/review` — idempotently accept or
  reject one proposal with exact-value conflict detection.
- `GET .../completion-readiness` — compare device-ready work with authoritative
  workflow, photo, sketch, and conflict blockers.
- `POST .../complete` — idempotently close field capture at an exact session
  revision without signing or submitting the report.
- `GET/PATCH /api/accounts/:id/property-tax-protest[...]` — load and save a
  revision-guarded desktop Property Tax Protest workfile.

Run UAD migrations first, then `npm run migrate:mobile`. The new API stays dark
until the migration, identity provisioning, and `MOBILE_INSPECTION_ENABLED=true`
are deliberately deployed.

## Next phases

1. Create the WorkOS staging public OAuth application, disable public signup,
   require MFA, map its test user to the synthetic HomeNode staging appraiser,
   and only then enable `MOBILE_INSPECTION_ENABLED` in Render staging.
2. Run physical-device staging across iPhone and Android, including offline and
   100-photo inspections plus the finish-on-site readiness gate.
3. Approve the private iOS and Android distribution channels and device policy.
4. Add optional LiDAR capture after the manual workflow is field-tested.

Before production UAD delivery, separately confirm all required UAD compliance,
submission credentials, approved endpoints, and certification/testing status.
Those credentials must not be folded into the mobile OIDC configuration.
