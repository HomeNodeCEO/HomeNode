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
