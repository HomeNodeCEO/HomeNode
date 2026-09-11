# One-read opening for saved Custom neighborhood studies

## Why

The prior workspace fetched its full recorded-group catalog and then separately
loaded the same retained evidence graph for the selected map/statistics. Hardy's
saved study took about 35.8 seconds for each request after PR734 (about 72 seconds
serially). Those are measured prior production timings, not a new latency promise.

## Contract and invariants

- The catalog endpoint accepts optional `initial_preview_groups`: the exact
  saved recorded-group IDs. Omission preserves the existing catalog response.
  The same dense-checkpoint validator bounds and detaches IDs before I/O.
- The owner resolves that list against the complete retained catalog, never the
  first page or a sampled roster. Unknown IDs refuse the read. Explicit `[]`
  produces an empty selection, not default-all. The map and shared/private sales
  summaries all use the same sorted union and selection revision.
- An opening response includes `initial_preview`, identical to a standalone
  preview for that union. Both catalog and summary exposures must be permitted
  before retained reads and again after the final material/assignment checks.
  Private-source checks, immutable-original verification, cancellation, existing
  deadlines and serialized heavy-operation admission remain unchanged.
- The graph is reused only inside that single request. There is no cross-request
  evidence cache, authorization cache, new source read, checkpoint write or Apply.
- Bounds remain 4MB for the catalog and 27MB for the map/summary preview. Only an
  explicitly requested opening may carry a 31MB combined envelope. Neither group
  membership nor geometry is clipped to fit; oversize requests fail explicitly.
- The v5 saved-workspace lifecycle asks for the combined response. Older saved
  workspaces first complete their existing catalog upgrade/CAS acknowledgment;
  first-time captures still save their initial selection before previewing it.
  On the next reopen, v5 uses the combined path without a migration or recapture.
- The frontend passes the opening response through the existing fingerprint,
  exact target/context/revision, summary and geometry checks. Nothing shortcuts
  validation because the data arrived alongside a catalog. Map and statistics
  publish together or neither publishes. Explicit retry uses a fresh request.
  Selection saves retain the controller and exact geometry; an explicit fresh
  reopen resets the opening owner even when its context/revision is unchanged.
  Session/organization/file/context changes still unmount that owner.

## Verification

Tests compare combined results with independent catalog/preview responses for
all, subset and empty selections. The fixture proves one retained-source read
instead of two; denial, changed material/assignment/policy, unknown IDs and input
mutation remain rejected. Frontend tests cover malformed/mismatched responses,
one-shot admission, fresh retry, exact empty restoration, older checkpoints,
reload, request cancellation, map reuse and bounded transport.

Native PostgreSQL checks cover the real HTTP opening and full private/shared
summary parity, including historical CSV prices and an empty selection. The
native coordinator's 41 check groups and blob rollback/isolation checks passed.
The existing 384MB-heap full-web synthetic fixture reopened 38,347 parcels,
38,106 accounts, 1,030 transactions, 887 named groups and 421,817 coordinates.
The combined projection was 24,513,248 bytes, completed in 18.76s, and peaked at
480,260KiB RSS. All 134 ordinary HTTP probes succeeded (p99 133ms, max 727ms).
This projection/load fixture is not a production load guarantee or a controlled
comparison against a separate run. Native owner tests cover the authorization
and final fences omitted from that large projection-only timing fixture.

Final local suites: 7,063 server tests passed, 33 database-gated tests skipped,
zero failures; all 2,347 frontend tests passed. TypeScript, lint/source budgets,
production build and bundle budgets passed (initial JavaScript 236KiB).

## Release and remaining work

Run complete server/frontend suites, TypeScript, lint/source budgets, production
build and protected CI. Deploy the compatible server addition with the frontend,
then reopen the same saved Hardy study; verify one opening request, unchanged
counts/revision/map/statistics/photos and no capture/Apply/selection writes.
Do not use this verification to apply September current CAD to an August report.

Independent pocket inspection and later selection previews still perform fresh
authorized reads. Large-catalog recommendations above 128 groups, recorded county
name compatibility, and historical housing-stock evidence remain separate tasks.
This slice changes neither scoring nor retrospective/report eligibility.
