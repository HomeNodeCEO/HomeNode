# Single-pass city membership

The live Custom capture coordinator now reads a city study through one
non-holdable PostgreSQL cursor, fetched in at most 500-row batches. It evaluates
the same bounding-box prefilter plus `ST_Intersects` city predicate in one query
instead of submitting another keyset query for every page. The existing public
keyset function and radius predicate/parameters remain unchanged.

## Preserved behavior

- Read-only repeatable-read snapshot before and after the complete scan.
- Original dated city Feature, subject point, source provenance, whole parcel
  geometry hashes, and deterministic sorted membership hashes.
- Holes and disconnected islands; crossing/touching parcels remain whole.
- No point-radius substitution, centroid test, clipping, mailing-city matching,
  geometric repair, or claim of authoritative provider coverage.
- Original city limits: 15 seconds overall, 5 seconds per query, 50,000 accounts,
  100,000 parcels, 16 MiB spatial metadata, and bounded individual row payloads.
- An exact-full last batch requires another fetch. Any invalid row, capacity
  limit, changed snapshot, or query failure refuses the entire result.
- The helper closes its portal on success and attempts bounded cleanup on
  failure. The existing caller still owns rollback and connection release.
- City processing does not change planner settings. The measured radius-only
  planner preference remains radius-only.

## Measurements and verification

Read-only local PostgreSQL/PostGIS benchmark, synthetic city with an interior
hole, 35,606 accounts / 35,847 parcels / 12,248,568 metadata bytes:

| Reader | Elapsed, two runs | Highest single SQL time | Peak RSS range |
| --- | --- | --- | --- |
| Keyset | 1,481 / 1,606 ms | 92 / 151 ms | 110,596–110,800 KiB |
| One-pass cursor | 693 / 691 ms | 91 / 88 ms | 118,932–120,268 KiB |

Both methods returned identical row, account-roster, and membership hashes.
This is a local acquisition-stage result, not a production whole-page speed or
capacity claim. The cursor adds duplicate-ID tracking and sorting, so the local
peak memory is slightly higher; it still retains the full bounded result.

Native tests compare both readers within the same snapshot, including islands,
holes, boundary touches, crossing parcels, invalid city geometry, complete
capacity refusal, unchanged planner settings, and zero remaining portals.
Unit tests also cover arbitrary scan order, duplicates, final empty fetch,
failed cleanup, snapshot changes, and all unchanged limits.

## Larger studies are a separate capacity change

This removes repeated city-query work but does not unlock studies above the
current limits. Full larger-area support requires paged retained rosters and
evidence, server-owned selection identities, independently paged map/catalog
delivery, and bounded complete-statistics processing. Source rights and atomic
boundary/statistics acceptance must continue to apply to the whole study, not
to a silently sampled subset. Existing saved reports are not changed here.
