# HomeNode Testing Priorities

Status: active, non-blocking quality queue.

This queue preserves acceptance and accuracy work without interrupting normal
feature development. A queued item blocks feature work only when it is promoted
to **P0** because it exposes data loss, security risk, assignment crossover, or
an incorrect signed report. Test evidence should record the build or commit,
test assignment, expected result, actual result, and any follow-up issue or PR.

## Priority definitions

- **P0 — Stop and fix:** security, data loss, cross-assignment contamination, or
  incorrect signed/final report output.
- **P1 — Schedule promptly:** material appraisal-data or workflow correctness.
- **P2 — Acceptance:** important coverage that can run alongside feature work.
- **P3 — Polish:** usability, layout, and edge-case refinement.

## Queue

### TQ-001 — Shared Custom Appraisal and UAD 3.6 completion acceptance

- Priority: P2
- Status: queued
- Scope: one new assignment and one existing assignment, each with a Custom
  Appraisal file and a same-assignment UAD 3.6 file.
- Verify that review-only UAD suggestions include supported subject/site,
  market, comparable, adjustment, approach, reconciliation, contract/history,
  condition, quality, amenity, location, and inspection evidence.
- Verify that roof, window, exterior/interior, update, repair, and appraiser
  comments appear with the correct assignment-scoped provenance.
- Verify that unsupported component classifications remain disclosed omissions,
  existing UAD values are preserved, selections apply individually, later UAD
  edits remain possible, and stale provenance/editor revisions are rejected.
- Verify that accepted changes pass the UAD workfile validator and deterministic
  MISMO XML gate, and that neither file can read a different assignment snapshot.
- Exit evidence: screenshots or response fixtures, validator/XML results, report
  file IDs, source digest, and any resulting issue or PR.

### TQ-002 — Signed Custom Appraisal file immutability and history

- Priority: P1
- Status: queued
- Verify unique file numbering, final-signature locking, archived PDF checksum,
  prior-service disclosure, and creation of a genuinely new file for a later
  assignment without changing the signed predecessor.

### TQ-003 — Automated neighborhood boundaries and sample representativeness

- Priority: P2
- Status: queued
- Exercise several property types and Dallas County locations, including the
  established Garland, Duncanville, Coppell, and Irving examples.
- Verify major-road boundary labels, editable appraiser-defined geometry,
  automatic land-use/profile loading, and the sold-versus-all-property
  representativeness calculation.

### TQ-004 — Zoning GIS and document-viewer accuracy

- Priority: P2
- Status: queued
- Sample every automated Dallas County city source and each manual PDF fallback.
- Compare the returned zoning code and verbatim description to the authoritative
  city source; verify that uncertain results remain reviewable and expose the
  appropriate city contact information.

### TQ-005 — Dallas County scraper repair-field audit

- Priority: P1
- Status: queued
- Recheck a bounded sample of repaired and newly scraped accounts for address,
  all owners and ownership percentages, state/use code, land, market value, main
  improvement, GLA, and the vacant-land rules. Confirm that valid vacant parcels
  are not treated as incomplete improvements.

### TQ-006 — Mobile field workflow acceptance

- Priority: P2
- Status: queued; owned by the mobile workstream
- Exercise a new and existing file on physical iPhone and Android devices:
  offline capture, reconnect/sync, proposal accept/reject/retry, same-field web
  conflict, sketch confirmation, verified-photo metadata, 100-photo handling,
  and the finish-on-site readiness gate.

### TQ-007 — Shared desktop/mobile photo evidence

- Priority: P2
- Status: queued
- Upload JPEG, PNG, and WebP originals from the desktop Property Report; confirm
  that the display derivative and original are verified, visible, and scoped to
  the correct assignment file.
- Capture photos with the mobile device offline, restart the app, reconnect, and
  confirm resumable upload into the same desktop gallery without duplicates.
- Confirm that signed files are read-only and removing a verified desktop photo
  excludes it from the report while retaining the original for five years.

## Promotion rule

When a queued test fails, create a focused issue or repair branch and promote it
to P0 only if it meets the P0 definition above. Otherwise keep feature work
moving and schedule the repair according to its recorded priority.
