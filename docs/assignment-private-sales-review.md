# Assignment-private CSV review

This phase adds persistent intake review to Custom Appraisal. It does **not**
publish CSV rows to shared sales, establish historical neighborhood inventory,
or add reviewed rows to the accepted neighborhood analysis.

## User workflow

Open a saved CSV's row receipts. Source interpretation is reviewed once per
batch, with explicit unknown options for currency, units, consideration and
marketing-time meaning. CurrentPrice remains distinct from ClosePrice.
Source-use confirmation records the reviewer's affirmation, not a provider
license grant. Per-row conflicts still require later supported interpretation.

Check current CAD proposals, stage individual confirmations or all proposed
matches on the visible page, and save the staged review. Duplicate or conflicting
rows cannot be automatically confirmed. Exclude and clear are separate explicit
decisions. Row controls collapse for compact display. Original uploaded rows
remain visible and unchanged after review.

Only a fresh committed PostgreSQL receipt is shown as saved. A temporary,
bounded sessionStorage record holds the exact review command and operation ID
for interrupted-save recovery. It contains no CSV bytes, candidate evidence,
authentication credentials, or report draft. It is scoped to actor, account,
assignment, report and immutable batch hashes, and is removed after the saved
receipt is checked. Failed or uncertain retries cannot replace this operation.
Session storage is a retry journal, not the authoritative review record.

## Persistence and API

Migration `20261016_assignment_sales_csv_reviews.sql` adds append-only review
history and a compact indexed per-row projection. It is registered in the
existing shared application migration sequence; no old migration is edited.
Revision checks serialize competing reviewers. Updates, deletion and truncation
are prohibited. The projection is derived from the immutable command and is
bound to its exact parent, ordinal and original receipt.

Under the existing assignment `sales-imports/:batchId` resource:

- `GET /reviews?report_file_id=...&after_row=...&limit=...` reads the current
  source declaration and latest decisions for the same visible row page.
- `POST /reviews?report_file_id=...` accepts review v1 JSON and an
  `Idempotency-Key` UUID; the authenticated actor is never taken from the body.
- `GET /reviews/operations/:operationId?report_file_id=...` recovers the exact
  committed receipt without issuing another write.

All owners use exact organization/assignment/report/account authorization,
bounded transactions and the existing signing lock order. Signed files are
read-only; exact already-committed operation replays remain readable. A new
review is denied after signing. Read-only users cannot create reviews.

The server recomputes current CAD proposals inside the write transaction and
requires the complete selected account set to agree. It retains the fresh
observation, not a browser-supplied proposal or replayed observation timestamp.
Sparse confirmations use their complete intervening source-row context within
a bounded 100-row span. The stored enriched review is limited to 2 MiB; the
command to 256 KiB. Excess is rejected as a whole, never silently clipped.
Latest row heads are indexed and at most 100 compact 8 KiB decisions are read;
raw rows and candidate evidence are not sent in the review-state response.

## Verification and remaining connection

Tests cover immutable source retention, exact scope, sparse multi-parcel
confirmations, duplicates, declared unknowns, stale revisions/candidates,
signed-file exclusion, competing appends, lost COMMIT acknowledgement,
readback hashes, database projection attacks, interrupted UI saves and
refresh recovery. Native tests use only newly migrated synthetic test databases.

The next phase must bind chosen immutable batches and exact review revisions
into a **new** private-source capture profile. Existing shared-source capture
profiles and their hashes remain unchanged. Matching, economic-property
membership, duplicate-event equivalence, supported source interpretation,
analysis eligibility and accepted report Apply remain separate gates.
Retrospective CSV sales do not replace missing historical stock evidence.
Final boundary and statistics must still apply through the existing coherent
Custom acceptance transaction. No shared-sales retention deletion is enabled.
