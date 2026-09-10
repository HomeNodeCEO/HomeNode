# Custom neighborhood report preparation

This is the next internal step after the [reviewed input calculation](custom-neighborhood-supported-inputs.md).
The existing `createCustomCohortContextCapture().prepareReviewedInputs()` caller
now also invokes `buildCustomCohortReportPreparation()`. It assembles an actual
version-one assessment and publication bundle and calls the existing Custom
report candidate mapper. It does not publish, accept, sign or modify a report.

## One saved review state

The preparatory result binds the retained context, selected pockets, selection
digest, current review generation/digest, actual report target and owner clock.
Its assessment and attachment UUIDs are explicitly unpublished preparation
identities. They are not a claim that an assessment revision exists in storage.

The owner reads the actual reserved `neighborhood_assessment` workfile-section
revision and a bounded database hash under the existing parent-workfile lock.
Absence means editor revision zero. A workspace checkpoint revision or pocket
selection revision is never substituted for that editor revision. After the
connection-free computation, the owner rechecks the editor revision and contents,
workspace, assignment/report target, subject material, current reviews and source
policy. Concurrent changes refuse the result rather than attach it to a new
state. The section hash is a freshness check, not signing evidence or authority.

The older evidence-inspection path still supports full PostgreSQL bigint
assignment identifiers. Identifiers beyond the report attachment contract's safe
integer range retain that inspection result and receive an explicit unavailable
report-preparation result; they are not rounded or relabeled.
An editor already at the maximum supported revision likewise returns an explicit
`report_editor_revision_exhausted` limitation; inspection cannot imply that a
subsequent accepted save can increment it.

## Exact populations and unchanged calculations

The assembler consumes the existing cached-record and statistics outputs; it
does not calculate another mean, median, dispersion or eligibility score.
It checks the reported counts against the exact contributing members and retains:

- Selected eligible stock as property members.
- In-period canonical transactions intersecting that stock, with complete
  co-parcel membership, including unselected co-parcels.
- The existing single-property recorded-price subset. Package prices are not
  allocated to individual houses or repeated as single-property observations.
- Original calculation results, diagnostics, review support and source evidence.

Four derived evidence sources are repackaged into bounded, content-addressed
chunks while preserving their original canonical digests and byte lengths.
Per-member references use the chunks containing that member's rows and proof,
not every source chunk in the study. Large property-price-member lists are also
chunked with an exact digest of the original complete statistics object. Nothing
is truncated to a convenient count of sales. Capacity failures produce an
explicit incomplete result, not a successful prefix of a larger population.

## What remains unavailable

This profile deliberately does not create report geography from a circle,
parcel union, pocket hull or guessed cardinal road name. The owner can now supply
an exact [saved manual outline](custom-neighborhood-manual-report-geography.md).
That preserves genuine drawing intent, native validity and the relation to the
exact retained subject centroid, but does not establish named perimeter edges,
complete subject-parcel containment or source applicability.
The geographic group therefore remains incomplete.

Retained field-specific reviewer assertions also do not establish a whole
source's historical applicability or provider authority. Repackaged snapshots
keep unknown historical availability and absent source validity periods. The
original computed values remain in their bound evidence, but report measures
remain null/incomplete until report-level source-period support exists. Missing
subject housing leaves calculation/report artifacts absent instead of supplying
a default housing type or zero statistics. An earlier data cutoff is not silently
treated as the stock effective date.

The actual candidate mapper consequently returns an incomplete candidate with no
applicable suggestions. `authority: not_established` and blocked Apply are retained
throughout. An internal source-bearing bundle is not a public API response or a
new permission to expose licensed source data.

## Remaining integration

The subsequent owner must provide supported source meaning/date applicability
and the appraiser's actual rough geography; validate the whole group; publish
under the existing job/assessment fences; obtain the appropriate presentation
rights; and use the existing transactional acceptance/save/reopen path. Boundary,
pockets, populations, statistics and evidence must be accepted together. Report
signing controls and authentication/authorization policy remain unchanged.
The CPU stage is bounded but synchronous; running it outside a database connection
does not itself move it off the web event loop. Production integration must use
the coordinated job/worker path rather than turn this internal source-bearing
method into an unbounded synchronous browser request.

Automated tests cover real preparation and candidate functions, genuine retained
fixture capture/review/reopen, exact package membership, unknown/partial support,
capacity behavior and owner freshness gates. Query doubles are not PostgreSQL
concurrency evidence; the native disposable-database checks cover the actual
section SQL and transaction behavior separately. Neither proves live production
source coverage or an interactive appraiser workflow.

The September 9, 2026 local verification passed all 60 new focused tests, 5,156
server tests (21 skipped), and 1,253 frontend tests. The fresh native database ran
79 unchanged canonical migrations and passed all existing source/review/checkpoint
groups plus the actual reserved-section hash and concurrent-change checks. The
frontend production build and bundle, source-size and lint gates also passed.
Interactive report-browser verification remains unobserved; protected remote CI
is still required before merging this slice.
