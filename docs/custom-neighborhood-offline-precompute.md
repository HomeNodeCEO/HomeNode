# Offline neighborhood CAD precompute

The Custom Appraisal neighborhood discovery still uses its authenticated,
assignment-bound, repeatable-read capture. Its parcel membership, source/sale
rows, effective-date limits, grouping, similarity, statistics, and appraiser
choices are **not** taken from a shared appraisal result. Each capture retains
the exact current source revision and the existing original-acquisition handoff.

The separate precompute job prepares only reusable *CAD polygon bytes and their
SHA-256 digests*. It does not contain MLS/NTREIS/CSV data or an appraiser's
report, and it is not a market or historical conclusion. This targets repeated
`ST_AsEWKB` and polygon-hash work on large neighborhoods; it does **not** remove
the cost of reading an exact 40–50k-account roster or producing a subject- and
date-specific analysis. The browser does not perform these database operations.

## Data and correctness

Migration `20261023_neighborhood_parcel_precompute.sql` creates two tables in
`app` (not `gis`), so application migrations do not imply CAD sync is present.
The precompute table is keyed by CAD `object_id` and stores the source tuple's
`xmin`, `source_record_hash`, exact EWKB hex and exact hash. The read-only
membership/source queries use the prepared value only when **both** the tuple
version and hash match the current original CAD row in the same database
snapshot. Otherwise the existing PostGIS expression runs. Updates after the
last scheduled pass are therefore immediately usable; a failed or skipped job
does not freeze source data. Deleted CAD rows are removed from the sidecar in
bounded batches. The retained parcel-map decoder independently checks the
EWKB against the membership hash and refuses a mismatch.

The cache is a performance hint, not evidence of source completeness, a license
grant, a city/legal boundary, an effective-date history, or permission to apply
statistics. CSV/Trestle sales continue through their existing authorization and
date checks. No median is averaged from cached subgroup medians.

## Production scheduling

1. Deploy the application with its existing pre-deploy `npm run migrate:application`
   step, then verify the new migration is recorded in `app.schema_migrations`.
2. Provision a separate Render **Cron Job** for the server repository/root,
   with the same private `DATABASE_URL` used for maintenance and the command
   `npm run maintenance:neighborhood-precompute`. Suggested schedule:
   `17 8 * * 0` (Sunday around 2–3 a.m. Central, depending on daylight time).
   Do not run this command inside the web process or share the routine
   maintenance job's worker slot.
   A full CAD sync may rewrite parcel tuples and temporarily remove cache hits
   even when their source hashes are unchanged. Trigger an additional run after
   every completed full CAD sync and verify its completion; the weekly run is
   only the backstop. If full syncs become frequent, increase the scheduled
   cadence after measuring database load rather than assuming weekly warmth.
3. Start one manual run after the migration. The session advisory lock rejects
   overlapping runs. Each statement has a 60-second query deadline, the job a
   45-minute default wall budget, and the pool has one connection. Set
   `NEIGHBORHOOD_PRECOMPUTE_BATCH_SIZE` (1–2000) and
   `NEIGHBORHOOD_PRECOMPUTE_MAX_RUNTIME_MINUTES` (1–720) only after measuring.
4. Check `app.neighborhood_parcel_precompute_state` for `status`, scan/refresh
   counts, completion time and bounded error code. Compare a cold/warm 513
   Hardy and 9582 Highedge capture using existing `source_read` timing logs and
   database query timing. Check storage growth with
   `pg_total_relation_size('app.neighborhood_parcel_precompute')` before raising
   cadence/coverage. Schedule during the actual low-traffic window.

If the cache lookup is slower or misbehaves in a specific database plan, set
`NEIGHBORHOOD_PRECOMPUTE_READ_ENABLED=false` on the web service and redeploy.
This restores the original live PostGIS expressions without deleting cached
rows or changing report/source semantics. The cron worker can stay stopped
while the index/query plan is diagnosed.

This is the first safe offline primitive, not a precomputed final neighborhood
report. A later city-index layer could persist date-vintaged subdivision/group
facts and map tiles, but only after measuring the remaining capture and preview
costs and adding source revision, authorization and historical replay tests.
