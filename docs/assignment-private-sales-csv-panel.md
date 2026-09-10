# Assignment-private sales CSV panel

The Custom Appraisal report exposes **Private neighborhood sales (CSV)** for an
authenticated, explicitly selected assignment. It is collapsed initially and
does not fetch until the user opens it. It does not poll, join report autosave,
or change neighborhood selections or calculations.

## What saving means

- Resolve the existing report UUID for the exact account/assignment; never choose
  a latest file or create a report implicitly.
- Upload at most 8 MiB of original CSV bytes to the private import owner.
- Display committed counts for every logical row, including duplicates, empty
  rows, rejected rows, and identity conflicts. Expand a row to inspect original
  cell text and separately labeled prepared observations.
- **Saved is not CAD matched, reviewed source interpretation, eligible evidence,
  or included in analysis.** A sales-only CSV cannot establish historical unsold
  housing stock. Source interpretation and capture admission are separate work.
- Original bytes and immutable receipts are retained by the backend. There is
  no deletion/retention action or shared-sales mutation in this panel.

## Recovery and lifecycle

Before sending a new upload, retain only its exact file name, length, SHA-256,
operation UUID, report UUID and account/assignment/user scope in session storage.
Do not store file bytes, row contents, credentials or report drafts there.
Unknown outcomes retain this operation ID; **Check saved upload** asks the owner
for a fully verified receipt. A missing receipt does not prove a previous request
cannot still commit. Retrying requires the same file contents and the same ID.

A fixed, explicit input rejection may release only a brand-new operation that
was not previously attempted. A prior uncertain operation is never released by
the response to a later retry. Storage unavailability blocks new uploads because
their operation ID could not be retained safely.

Changing assignment or authenticated user disposes the old panel, cancels its
requests and prevents late responses from updating the new panel. Requests and
file-read work have bounded deadlines. Busy state is scoped to active work, not
to an unresolved outcome, so a pending receipt does not create endless polling.

Save Everything and finalization reject entry during active panel work. Explicit
Save Everything also prevents a new upload for its exact target until its lease
finishes; this lock does not follow background autosave. Signed/read-only files
remain readable but cannot start an upload. Server authorization and workfile
locking remain authoritative.

## Verification

`scripts/testPrivateSalesImports.mjs` covers exact response scope, bounded pages,
raw upload and idempotency contracts, missing/uncertain receipt recovery, invalid
first-upload recovery, cancellation, and panel lifecycle behavior.
`scripts/testCustomNeighborhoodReportSaveBridge.mjs` covers actual report handler
ordering and the upload/save interlock. `testPropertyReportAssignment.mjs` retains
result parity for the small pure display/hydration extraction used by this mount.

Browser acceptance uses a loopback-only synthetic assignment with the real
router, storage owner and migrated PostgreSQL database: invalid input, successful
save, duplicate row accounting, expanded receipts, read-only controls and reload.
This is not a production-data or production-deployment acceptance claim.
