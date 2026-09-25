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

## City and recorded-subdivision index (second primitive)

Migration `20261024_neighborhood_group_index.sql` adds one indexed set of
PostgreSQL tables keyed by normalized county, city, and recorded subdivision.
It deliberately does **not** create one physical table per city or subdivision:
that would add thousands of migrations and make cross-city searches harder.
`app.neighborhood_group_parcel_facts` holds the current CAD GLA, year, site,
value and recorded-label facts. `app.neighborhood_group_sale_facts` holds
account-matched sales with their original closing dates and prices.
`app.neighborhood_group_summary` stores citywide descriptive counts and
medians for quick browsing. The sales fact index supports exact appraisal
period filtering; medians for arbitrary selected groups must be recomputed
from those indexed facts, never averaged from summary medians.

Migration `20261025_neighborhood_group_characteristics.sql` extends each
prepared parcel with current CAD bedroom and bath counts, explicit pool
status, and measured garage/outbuilding areas from separately recorded
secondary improvements. The summary retains observation counts alongside
medians and pool-presence counts. Missing CAD rows remain **unknown**, not
zero bedrooms, no garage, or no pool; garage area is not converted into an
invented garage-space count. An unusually large outbuilding can later affect
only a low-weight supporting similarity factor. None of these current CAD
fields establishes an amenity's presence on a retrospective effective date.

The separate, current-CAD supporting-similarity kernel reserves at most ten
percentage points for five optional characteristics: bedrooms 2.5, baths 2.5,
measured garage area 2, explicit pool status 1, and measured outbuilding area
2. Missing observations have no effect on the established physical score; an
unusually large outbuilding can therefore lower the combined diagnostic by no
more than two points. The kernel is not connected to the report/map scoring
contract yet: prepared current facts first need a source-revision and
effective-date-safe read path. Its presence does not change existing map
colors, recommendation ranks, or appraisal conclusions.

Run `npm run maintenance:neighborhood-group-index` in a **separate** off-hours
worker, never the web process. It uses one connection, a session advisory lock,
and one repeatable-read source snapshot. The next generation becomes visible
through `app.neighborhood_group_active` only after all CAD/sale facts and
summaries finish; failure leaves the previous generation in place. A later run
prunes obsolete generations in bounded batches. Inspect the active generation's
`source_observed_at`, `completed_at`, counts and table sizes before scheduling
a nightly cadence. Defaults: 1000 source rows per batch and a 90-minute wall
budget; configurable limits are `NEIGHBORHOOD_GROUP_BATCH_SIZE` (1–5000) and
`NEIGHBORHOOD_GROUP_MAX_RUNTIME_MINUTES` (1–180). Run one measured canary first
and do not schedule overlapping CAD full syncs or other bulk maintenance.
Source batches have a 120-second query limit; the full-group median and sales
summary statements have a separate 10-minute limit under the same overall job
budget. Static phase/progress logs identify which bounded step needs tuning
without printing source data or database connection details.
The account-to-recorded-group key for sales is built once per generation in a
transaction-local table. This avoids repeating cold, per-sale parcel-index
lookups after the large parcel copy. The one-pass join preserves the original
rule: accounts with missing, conflicting, or unlabeled parcel facts keep null
group keys, and no sale is silently assigned to a subdivision. The temporary
table is discarded on both commit and rollback.

These tables are **not yet read by the report or map**. They are the prepared
lookup foundation, not a claim that a three-mile capture is now instant. The
live QA retry still exceeded the request window during retention after source
read and preparation; subsequent work must use this index to reduce capture
work or move long captures to a durable background job. Source authorization,
date selection, report statistics, and the appraiser's saved choices remain on
the existing exact-source path until parity tests and performance measurements
justify switching. Current CAD observations do not establish what existed on
a retrospective effective date. A group name is not a verified legal
subdivision/phase identity, and unknown or conflicting names are excluded
from group summaries but retained as raw facts for review. Sales originally
loaded from CSV and later from Trestle use the same `core.sales` facts after
account reconciliation; this index does not grant separate MLS redistribution
or override assignment-level access rules.
