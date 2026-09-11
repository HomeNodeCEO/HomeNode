# Online neighborhood spatial indexes

Run `node scripts/prepareNeighborhoodSpatialIndexes.js` from `server` to inspect,
then `node scripts/prepareNeighborhoodSpatialIndexes.js --apply` on a dedicated
operator connection using the existing `DATABASE_URL`. Do not run inside a
transaction, on web requests, or as an automatically blocking startup migration.
This creates two indexes concurrently and does not rewrite parcels or source data.

The existing capture deliberately rejects any invalid/missing cached geometry.
On the production-sized mirror its unindexed full-table validation hit the
five-second SQL timeout. A partial B-tree contains exactly the rejected rows;
PostgreSQL maintains it during changes, so no stale validation flag is introduced.
The existing full gate query is unchanged and remains authoritative. A separate
GiST expression index supports the existing `geom::geography` distance predicate;
the ordinary geometry GiST cannot substitute for it.

The script defaults to inspection, skips already-valid named indexes, and stops
on invalid/unready or wrong-table indexes. It never drops or rebuilds indexes.
If a concurrent build fails, inspect its state and explicitly plan recovery before
retrying. Index definitions are included in inspection output for review.
The dedicated connection uses 64 MB maintenance memory, a five-second lock wait,
and a ten-minute build limit. Normal request deadlines and membership caps stay
unchanged. Concurrent creation permits ordinary reads/writes but still adds I/O;
run one instance of this job and observe service/database health.

Acceptance: compare the rejection query results before/after on valid, null,
self-intersecting, and subsequently repaired fixtures; verify valid/ready state
and index query plans; then rerun the same saved capture UUID. Complete cached
membership still does not establish provider coverage or historical applicability.
