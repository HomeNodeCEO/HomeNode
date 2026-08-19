# Mobile target-field adapters

Status: Phase 8 connects offline field observations to the existing UAD 3.6 and
Property Tax Protest report targets through separate, review-only adapters. It
does not combine those workflows, alter Custom Appraisal mapping, or enable UAD
submission.

## Domain boundary

| Mobile workflow | Canonical target | Accepted-change history |
| --- | --- | --- |
| Custom Appraisal | `app.assignment_files` | Assignment revision/history and report registry events |
| UAD 3.6 | `appraisal.uad_workfiles` and `appraisal.uad_field_values` | `appraisal.uad_revisions`, UAD audit events, and report registry events |
| Property Tax Protest | `app.tax_protest_files.workfile_data` | `app.tax_protest_file_history` and report registry events |

The shared inspection session, offline queue, photos, and sketch are transport
and evidence infrastructure. They do not become a fourth canonical report. A
target adapter can address only the report file selected when the inspection
session was opened.

## Field workflow

1. The app opens `target-fields` and caches the selected report's catalog,
   canonical values, target revision, existing UAD entities, verified-photo
   index, and prior proposals.
2. Field edits save to the user-scoped encrypted SQLite database. The queue
   records both the prior inspection observation and the exact canonical target
   value/revision visible when the form was loaded.
3. Normal offline synchronization appends sparse inspection observations. It
   does not mutate the UAD or protest file.
4. Proposal refresh validates the observation against the target-specific
   catalog and creates one review proposal per latest field edit. An invalid new
   observation cannot supersede an earlier valid pending proposal.
5. The appraiser explicitly selects **Accept into report** or
   **Keep inspection-only**. Review requests have their own idempotency UUID.
6. Acceptance locks the target, compares its current field state with the
   device-captured target base, and applies only that field when they match.
   A changed field becomes a visible conflict and remains unmodified.

Unrelated canonical changes do not block acceptance. There is no whole-document
last-write-wins replacement in the mobile adapter.

## UAD 3.6 adapter

The mobile catalog is generated from `getUadEditorSections()`, the same locked
official field catalog used by the web UAD editor. Each path contains the UAD
section/context/UID and, for repeatable records, an existing entity UUID. Values
are validated by the existing UAD type, enumeration, format, unit, and bound
rules before a proposal can exist.

An accepted field:

- inserts, updates, or explicitly clears one `appraisal.uad_field_values` row;
- records appraiser confirmation and an override reason when replacing a
  non-appraiser source;
- increments the workfile revision and appends an immutable UAD document
  revision;
- appends a UAD audit event; and
- increments the selected report file's registry revision.

Phase 10 adds a separate reviewed workflow for creating and removing the
repeatable entity types already defined by the official HomeNode UAD catalog.
See `MOBILE_UAD_REPEATABLE_ENTITIES.md`. Comparable creation and repeatable
comparable children follow the canonical web UAD catalog and review contract.
Submission credentials, approved endpoints, certification, and lender/GSE
delivery remain separate from mobile OIDC and must be confirmed before
production UAD delivery.

## Property Tax Protest adapter

The bounded protest catalog covers subject condition and quality, living area,
bed/bath count, condition notes, deferred maintenance, cost to cure, tax year,
district/requested/appraiser values, sales and adjustment support, district
evidence, protest rationale, and field comments.

Acceptance updates only the selected `app.tax_protest_files` JSON path,
increments its revision, and appends `app.tax_protest_file_history`. Unknown
workfile keys are preserved. Known fields are normalized and validated on both
mobile acceptance and desktop save.

The existing Property Tax Protest page now includes a separate canonical review
card. It loads accepted mobile values, the verified photo index, and the latest
sketch status. Desktop save requires the HomeNode editor key and exact expected
revision; a concurrent save reloads instead of replacing the newer work.
The older rough-draft analysis controls remain independent.

## Persistence and audit

Migration `20260827_mobile_target_adapters.sql` adds:

- `target_base` and `target_base_revision` to inspection field edits;
- `app.mobile_target_field_proposals` for immutable base/proposed state and
  review status;
- `app.mobile_target_review_operations` for idempotent accept/reject requests;
  and
- `app.mobile_target_adapter_events` for proposal lifecycle audit.

Pending proposals are unique per session and field path. A newer valid synced
observation supersedes the prior pending proposal without deleting it. Accepted,
rejected, conflicted, and superseded proposals remain queryable.
A conflicted proposal keeps the session in review-required state until it is
kept inspection-only or superseded by a newer deliberate observation.

## API

Authenticated mobile routes:

- `GET /api/mobile/inspection-sessions/:id/target-fields`
- `POST /api/mobile/inspection-sessions/:id/target-fields/proposals/refresh`
- `POST /api/mobile/inspection-sessions/:id/target-fields/proposals/:proposalId/review`

Desktop routes (the mutating `PATCH` requires the editor key):

- `GET /api/accounts/:id/property-tax-protest?file_id=<uuid>`
- `PATCH /api/accounts/:id/property-tax-protest/:fileId`

The mobile capabilities response advertises both target workflows, offline
sparse edits, explicit review, exact-value conflict detection, official UAD
catalog use, and protest version history.

## Verification and rollout

Run UAD migrations first, then the additive mobile migrations:

```powershell
cd server
npm run migrate:uad
npm run migrate:mobile
```

Keep `MOBILE_INSPECTION_ENABLED=false` until the staging database has the
migration, the chosen managed OIDC environment is configured, an internal user
identity is linked, and iPhone/Android offline field tests have passed. No
production database migration or public application distribution is implied by
this phase.
