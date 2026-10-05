# Complete larger-area Custom neighborhood studies

## Current boundary

The installed capture mode is bounded, not sampled. A study that exceeds an
account, byte, geometry, work, or time ceiling is refused as a whole. Its previous
saved study and accepted boundary/statistics group must remain unchanged.
Single-pass city acquisition improves query work within these bounds; it does
not certify that any particular city or five/ten-mile study fits.

Increasing one limit is unsafe because the same complete study passes through
several independent boundaries:

| Boundary | Current constraints that affect larger complete studies |
| --- | --- |
| Spatial membership | 50k accounts, 100k parcels; new compact16 MiB encoded /32 MiB expanded; legacy16 MiB; full arrays |
| Canonical roster/query evidence | One 1.5 MB JSON roster before page construction; 50k accounts |
| Read capability and transaction closure | 50k accounts; bounded capability lifetime and complete closure |
| Dense source acquisition | 200k records / 128 MB, including selected roster rows, CAD account rows, parcel rows, sales and links |
| Retained graph | 4k blobs / 12k references / 512 MB logical charges; reopen assembles arrays |
| Statistics | 50k accounts; 2m measurement / 500k member work; dense indexed output64 MB |
| Recorded-group catalog | 100k combined CAD account/parcel records; 1,024 groups; ~4 MB public response |
| Map | 500k coordinates, 24 MB GeoJSON, whole-map response27 MB |
| Browser selection | 50k accounts / 100k memberships / 3.9 MB request representation |
| Report publication | 100k combined members / 250k links / 32 MB members / 64 MB retained report |

These are data/operation-specific limits, not interchangeable grants. Missing
source rights, historical stock evidence, known sale prices, units, or housing
classification cannot be remedied by increasing capacity.

The lossless new-capture representation is documented in
`custom-neighborhood-spatial-encoding.md`. It removes repeated field names but
does not remove the full-roster/count/downstream limits described here.

## Implementation sequence

1. Preserve the existing protocol. Add a versioned page-oriented roster and
   evidence manifest with ordered streaming digests, exhaustive membership
   verification and immutable row lineage. Remove dependence on one giant
   roster string; do not call a prefix a complete study.
2. Process complete capture stages in a bounded durable job, with checkpointed
   operation identity, cancellation, timeout recovery and atomic final context
   registration. An unfinished job never replaces an accepted study. Existing
   request/organization/assignment rights still gate each operation.
3. Keep selections server-owned and refer to an exact selection revision/hash.
   Page catalogs, member inspection and geometry independently of the complete
   analytical population. Geometry tiles/pages must preserve the whole source
   geometry; visual simplification cannot become statistical membership.
4. Compute exact complete-population statistics using bounded passes or stored
   order statistics. Never average page medians or silently choose a target
   sale count. Combine overlapping pocket memberships as a true set union.
5. Version and validate publication/consumer budgets together. Continue to
   apply manual boundary, population identity, statistics and provenance as one
   coherent group. Reopening older captures must retain their original version
   and meanings; new capture data must not rewrite old accepted reports.

## Release acceptance

- Compare 3-mile results byte-for-byte with existing retained fixtures.
- Complete synthetic >50k, 5-mile, 10-mile and dated-city studies without
  discarded rows; explicitly disclose records lacking usable observations.
- Verify holes, islands, crossings, duplicate account parcels and overlapping
  groups; final member identities, not just counts, must match.
- Exercise exact caps and one-over, cancellation between pages, changed source
  snapshots, revoked permissions, stale selection, lost commit acknowledgment,
  retries, reload and atomic boundary/statistics Apply.
- Measure peak memory, SQL latency, event-loop responsiveness and HTTP payloads
  on realistic geometry/row sizes; do not infer production capacity from tiny
  rectangles or empty-sale fixtures.
- Prove map paging does not restrict statistics to the currently visible map.
- Preserve the genuine retrospective report; perform live Apply tests only on
  an explicitly designated QA draft. No signing/delivery assertion follows
  merely from successful neighborhood testing.

## Phase 1 streaming primitive (not live capture yet)

`cohortPagedRosterV2.js` stages ordered account pages and verifies the same
selection and query digests as the retained v1 contract without building a
single account-array preimage. It also verifies every original page and the
directory on reload. A 60,000-account test exceeds the old whole-document
ceiling, and tests reject missing, reordered, repeated, altered and cancelled
pages. `cohortPagedRosterV2Store.js` binds that verifier to the existing
organization-scoped immutable evidence-blob repository. It checks each storage
acknowledgment and reloads every original by hash and byte length. The caller
must supply a transaction-bound repository, roll back on any failure, and
commit only after the complete roster, source closure and authorization checks
succeed. This
primitive alone does **not** raise the live 50,000-account ceiling or grant
source access. The remaining capture, storage, statistics, map, and report
budgets in the table above remain enforced until subsequent phases land.

## Phase 2 job prerequisites (not a live job runner)

`customCohortJobActor.js` reloads the original actor's *current* active user,
organization membership, and roles from PostgreSQL. A future resumable capture
must use this current identity and the existing assignment and market-source
policy checks before each resumable operation and final registration. It must
not persist an old browser token or treat a queued job row as an authorization
grant. The additive `neighborhood_custom_cohort_capture_jobs` ledger and
`customCohortCaptureJobRepository.js` now provide an exact-request idempotency
key, bounded token-free request payload, fenced leases, retries, cancellation,
bounded checkpoint references, and a success transition that requires the
matching immutable context within the caller's transaction. Neither component
is a source authorization or a complete capture. A worker that performs and
resumes each capture phase, integrates paged evidence, rechecks current rights,
and wires the HTTP status/cancel flow is still required. The installed live
capture route and its 50,000-account limit are unchanged by this slice.

The next internal command surface admits a token-free job request only after
current Custom Appraisal assignment write access is checked. Status reads and
cancellation recheck exact organization/report/assignment/account scope and
current read/write access, respectively. This surface is intentionally not
mounted in HTTP until the stage worker exists; it cannot be mistaken for a
working asynchronous capture. Status responses omit checkpoint references and
internal source errors. A lost cancellation response can be retried against a
terminal job without altering its outcome.

The first worker pass is available through the separate
`maintenance:neighborhood-capture-jobs` command. It claims one due operation,
reloads the actor's *current* active membership/roles, polls cancellation and
renews a fenced lease, then invokes the existing bounded capture. The final
context registration and job success share a transaction; a lost lease or
cancellation rolls back that registration. A committed context whose response
was lost is replayed under current rights before the matching job is completed.
This worker is not yet scheduled or exposed through HTTP and still enforces the
installed 50,000-account ceiling. The remaining phase checkpoints, paged source
capture, larger-area statistics/map/publication contracts and live acceptance
must land before this path can serve a 5- or 10-mile study.
