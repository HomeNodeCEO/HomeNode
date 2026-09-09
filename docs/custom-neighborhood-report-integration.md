# Custom accepted neighborhood report integration

This slice connects an **already accepted** neighborhood group to the Custom
editor and PDF. It does not activate live discovery, issue source permissions,
decide factual eligibility, or provide the interactive Apply workflow.

## One saved group

The versioned Custom catalog partitions the normalized assessment into five
dependent targets: geography, selection, populations, statistics and evidence.
These are values inside the reserved `neighborhood_assessment` workfile section,
not writable aliases in `assignment_details`. The shared application planner
rejects partial groups, stale revisions and inconsistent actual occupancy. A
capacity rehearsal uses the real manifest, receipt and 850,000-byte section
normalizer before advertising a candidate as ready; its dummy receipt never
leaves that pure rehearsal or authorizes a save.

The projector checks exact catalog keys, mapper version, target identity and
normalized assessment equality. The owner must additionally verify authorization,
acceptance/history and freshness. Projection alone is never source verification.
All supplied populations and statistics are retained without first-30 limits,
pooling pocket medians, or recomputing values during display. Median, predominant,
CAD assessed value, sale consideration, allocated prices, age bases and count
denominators remain distinct. Number formatting changes presentation only.

## Editor

The existing Custom assignment selection handler always requests the authoritative
accepted read for an editable file, even when the earlier workfile response has
no reserved section. This check does not block hydration of unrelated report
sections. Only an exact `not_accepted` response permits legacy analysis.
Missing, mismatched, failed and signed responses never silently enable legacy
neighborhood generation. The current account/assignment, exact section, operation,
revision and report projection must agree before accepted data renders.

The accepted summary and saved-outline diagram are lazy-loaded. Legacy profile
requests, delayed callbacks, automated neighborhood field updates and market-area
imports cannot overwrite accepted or currently-loading data. The diagram preserves
separate rings/holes; it is explicitly not a street basemap or a new pocket geometry.
It neither draws invented boundaries nor exposes a new editing action.

## Draft PDF and signed files

Draft readiness/download resolves the independent current report link together
with the exact section, immutable acceptance/history, published assessment,
organization/account/case/snapshot and effective date in one database statement.
An absent section requires an authoritative check for any retained acceptance or
concurrently appearing section; otherwise old aliases could reappear in export.
Malformed or mismatched groups block export rather than printing legacy numbers.

Direct signing repeats this exact present/absent check on its existing locked
transaction before capturing the signed manifest or running readiness. A lost
section with retained acceptance cannot bypass the draft-export guard by signing
directly. Signer permissions, HMAC construction, snapshot shape and previously
signed idempotent replay remain unchanged.

A valid group replaces the legacy neighborhood page and adds a paginated evidence
appendix before photos. Every supplied population/statistic/source is included;
photo pagination and the public Buffer renderer API are preserved. The existing
verified stored signed-artifact return path is unchanged. A signed snapshot without
an independently captured report-link list has an explicitly signed-only fallback
to its already verified exact group; an explicit conflicting/empty list never does.
This is not a substitute for the caller's signature and scope verification.

## Verification and remaining work

Local tests cover real catalog/receipt construction, section limits, exact and
conflicting readback, authoritative absence, delayed file responses, formatting,
all-statistic PDF text/pagination and separate ring drawing. The production build
and bundle budgets pass. Synthetic browser and PDF visual checks are not proof of
production data coverage or real-property appraisal accuracy.

Native PostgreSQL verification passed on September 9, 2026: all 31 atomic-save,
editor-read and draft-binding checks passed on a fresh, canonically migrated
local test database. This includes current-section loss, changed subject/date,
cross-file rejection, rollback and coherent reads across a concurrent commit.
The separate caller-snapshot native test passed all seven tests against actual
PostgreSQL/PostGIS. Its CI runner now creates its own fresh loopback fixture
database; a skipped native test is not accepted as success. Remote CI remains
required, and neither native suite proves real-property/provider accuracy.

The real source-to-Apply owner is not yet connected. Keep this work isolated
until that integration is complete. Next connect freshly authorized source/context capture, complete discovery,
evidence-backed cohort eligibility, coherent publication, actual catalog occupancy,
atomic Apply, pocket editing and real Hardy/Snowmass/Aaron acceptance checks.
