# Mobile Custom Appraisal adapter

Phase 5 connects synchronized field observations and verified field-photo metadata to a selected Custom Appraisal file. It does not change the independent UAD 3.6 or Property Tax Protest targets.

## Data boundary

- `app.inspection_field_edits` remains the immutable, provenance-bearing inspection record.
- `app.custom_appraisal_proposals` maps only allowlisted field paths to a specific `app.assignment_files` record.
- `app.custom_appraisal_sections` stores assignment-scoped Property Characteristics. It may use the current property-wide Property Report section as an initial seed, but it never updates that property-wide record.
- Assignment Details observations update only the selected assignment file and create the existing assignment-file history snapshot.
- Every accepted report update increments the report-file registry revision and records report, adapter, section, and review-operation audit evidence.

An accepted field is a sparse update. The adapter compares the exact target field with the value observed when the proposal was prepared. An unrelated report change does not block the field; a change to that exact value creates a visible conflict and writes nothing to the target.

## API

All routes require the existing managed OIDC identity, organization membership, write role where applicable, and ownership of the selected inspection session.

- `GET /api/mobile/inspection-sessions/:sessionId/custom-appraisal` returns the field catalog, assignment-scoped sections, proposal history, current values, and verified photos attached to the report file.
- `POST /api/mobile/inspection-sessions/:sessionId/custom-appraisal/proposals/refresh` creates review proposals from the latest synchronized, allowlisted field observations.
- `POST /api/mobile/inspection-sessions/:sessionId/custom-appraisal/proposals/:proposalId/review` accepts `accept` or `reject` with a client operation UUID.

Review operation UUIDs are idempotent. Reusing one with a different proposal or decision returns a conflict.

The existing assignment-file list endpoint also returns:

- `custom_appraisal_sections`, keyed by report section;
- `mobile_inspection_photos`, containing only verified, file-scoped photo metadata and retention dates.

The Property Report overlays the active assignment file's accepted characteristics for display and identifies the count of verified field photos. Property-wide manual values remain unchanged.

## Mobile workflow

The native Custom Appraisal panel groups fields into Basics, Exterior, Interior, Systems & Amenities, and Condition & Repairs. It supports explicit clearing, typed numeric and boolean values, condition ratings, and long-form observations.

1. A changed group is saved to encrypted SQLite.
2. The existing durable queue synchronizes it as an inspection observation.
3. The adapter refresh creates review cards.
4. **Accept into this appraisal file** applies the sparse update after the exact-value check.
5. **Keep inspection-only** retains the observation and audit history without updating the report.

The field catalog and latest review snapshot are cached for offline use. Report acceptance remains online because PostgreSQL is authoritative.

## Photos and retention

The adapter reports only photos whose original/display objects were verified and whose `report_file_id` matches the selected appraisal. Excluded or incomplete photos are not counted as active report photos. Existing five-year retention, legal-hold, and original-file preservation rules continue unchanged.

## Deployment

1. Deploy the server and mobile/web clients to staging.
2. Run `npm run migrate:mobile` against the staging `homenodedb` service. Migration `20260824_mobile_custom_appraisal.sql` is additive and checksum-tracked.
3. Keep `MOBILE_INSPECTION_ENABLED=false` until managed OIDC is configured and approved.
4. Exercise one new and one existing Custom Appraisal file: offline save, reconnect, proposal refresh, accept, reject, retry, same-field web conflict, Property Report retrieval, and verified-photo metadata.
5. Do not apply the migration to production until the staging evidence is reviewed.
