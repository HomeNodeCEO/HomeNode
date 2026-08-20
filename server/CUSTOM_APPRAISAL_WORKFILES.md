# Custom Appraisal workfiles

Custom Appraisal assignments use the existing `app.assignment_files` row as
their identity. Browser storage is only a one-time compatibility source for
older drafts; current Sales Comparison and Market Conditions work is stored in
the database.

## Durable model

- `app.custom_appraisal_workfiles` gives every assignment a UUID and a unique,
  recognizable canonical filename. The assignment row ID is included in the
  filename so identical client file numbers cannot collide.
- `app.custom_appraisal_workfile_sections` stores independent JSON sections.
  Each section has its own optimistic revision, preventing a market-study save
  from overwriting a simultaneous comparable-grid save.
- `app.custom_appraisal_workfile_section_history` retains every successful
  section revision and its editor/save reason.
- `app.custom_appraisal_signed_snapshots` stores one immutable, SHA-256
  checksummed snapshot per finalized assignment.

The signed manifest includes the assignment details, all workfile sections,
and metadata/checksums or durable object references for linked source
documents, mobile photos, sketches, property context, and neighborhood
evidence. Source PDF and image bytes remain in their purpose-built retained
storage rather than being duplicated inside the JSON snapshot.

## Lifecycle

1. Creating a desktop or mobile Custom Appraisal file creates its workfile row
   and registers it with `app.report_files` when that registry is available.
2. The Property Report loads the requested assignment file (or the latest one)
   and the Sales Comparison page receives that file ID in its URL.
3. Sales Comparison autosaves the complete grid/workspace to the
   `sales_comparison` section. Market Conditions saves to `market_conditions`.
4. A successful database save removes the old sales browser draft. Legacy
   browser drafts can still be imported once when a database section is empty.
5. Finalize & Lock first calls the server-authoritative readiness endpoint. Its
   blockers cover assignment, contract, PUD/HOA, conformity, neighborhood,
   market-study, comparable, and value-reconciliation requirements. Source-data
   repair concerns (including an incomplete CAD status or missing owner, legal,
   site, GLA, or condition evidence) are explicit warnings that the appraiser
   must acknowledge. The server reruns the same checks while signing so a stale
   browser cannot bypass a new blocker or warning.
6. The signed snapshot records the appraiser, exact acknowledged warning codes,
   E&O evaluation, checksum, and immutable PDF. Later assignment/section/mobile
   edits are rejected; corrections belong in a new appraisal file.
7. The Assignment Log can download either the current database draft or the
   immutable signed snapshot using its canonical filename.

`GET /api/accounts/:id/assignment-files/:fileId/workfile/readiness` is an
on-demand preflight and does not run during normal Property Report loading.
That preserves the lazy-rendered fast path while giving the appraiser an exact
preview of what the signing transaction will enforce.

## Deployment and testing

`20260828_custom_appraisal_workfiles.sql` is part of the ordered mobile
migration runner. Startup also ensures the additive tables and backfills any
historical assignment files, which keeps older deployments recoverable.

Relevant checks:

```text
node --test
node node_modules/vite/bin/vite.js build
node scripts/testComparableAdjustments.mjs
node scripts/testConditionQualityRatings.mjs
node --experimental-strip-types scripts/testNeighborhoodAutomation.mjs
node --experimental-strip-types scripts/testMarketAreaAutomation.mjs
```
