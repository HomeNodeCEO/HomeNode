# Performance and scheduled-maintenance operations

## UAD artifact and object-storage resilience

The UAD web process coalesces duplicate XML, PDF, and submission-package
requests and admits a bounded number of heavyweight artifact operations. The
safe defaults are one active operation and two queued operations. Excess work
returns `503 uad_artifact_capacity_exceeded`; queued work that cannot begin in
15 seconds returns `503 uad_artifact_queue_timeout`.

Submission packages are assembled as deterministic temporary files. Verified
source objects are streamed from R2, incorporated into the ZIP, removed from
temporary storage, and the finished ZIP is streamed back to R2. The web process
does not retain all evidence files plus a second complete ZIP buffer in memory.

Supported controls:

```text
UAD_ARTIFACT_MAX_CONCURRENT=1
UAD_ARTIFACT_MAX_QUEUED=2
UAD_ARTIFACT_QUEUE_TIMEOUT_MS=15000
UAD_ARTIFACT_STALE_AFTER_MINUTES=15
UAD_PDF_MAX_SOURCE_BYTES=67108864
R2_REQUEST_TIMEOUT_MS=30000
R2_STREAM_TIMEOUT_MS=120000
R2_MAX_ATTEMPTS=3
R2_RETRY_BASE_MS=250
R2_MAX_BUFFERED_DOWNLOAD_BYTES=67108864
READINESS_MAX_DATABASE_WAITERS=5
```

`GET /health` is the inexpensive liveness probe. `GET /ready` checks shutdown
state, database connectivity and pool pressure, artifact-executor availability,
startup schema initialization, authentication posture, and memory pressure.
Required property, appraisal, assignment-file, document, and workfile schemas
must finish initialization before readiness returns HTTP 200. Signup capture and
the scheduled Census/location backfill schemas are auxiliary; their failures are
reported as stable warnings without creating a liveness restart loop. Readiness
responses expose only bounded component codes, never SQL or dependency errors.

Memory readiness defaults to 85 percent of the container limit when Node can
discover that limit. `READINESS_MAX_RSS_MB` can override it. Render should use
`/health` for automatic process restart and `/ready` for deployment verification
and alerting; a database outage should not create a liveness restart loop.

At startup, artifact rows left in `generating` beyond the configured stale
window are marked `failed` with the bounded recovery code
`uad_artifact_generation_interrupted`. A normal regeneration can then replace
the interrupted artifact for the same workfile revision.

## Runtime separation

The web process serves property searches, reports, comparisons, and on-demand
lookups. It does not start recurring Census or sale-coordinate batches unless an
operator explicitly sets one of these temporary fallback flags:

```text
LOCATION_BACKFILL_ENABLED=true
CENSUS_GEOGRAPHY_ENABLED=true
```

Both flags default to `false`. Normal production maintenance uses short-lived
scheduled processes instead:

```text
npm run maintenance:scheduled
npm run maintenance:roads
```

Recommended Render schedules:

- Routine maintenance: daily during low traffic, command
  `npm run maintenance:scheduled` from the `server` root.
- Road-context refresh: monthly during low traffic, command
  `npm run maintenance:roads` from the `server` root.

Future flood, zoning, road, and influence imports belong in the scheduled task
registry in `src/services/scheduledMaintenance.js`; they must not be added to
web-server startup.

## DFW county onboarding prerequisite

The Census and parcel-context jobs enrich accounts already present in
`core.accounts`; they do not discover or download a county's complete appraisal
roll. Before treating a DFW county as covered:

1. Obtain the county appraisal-district account inventory (CSV until an
   approved automated feed is available).
2. Upsert the county account IDs, county name, situs address, city, and ZIP into
   `core.accounts` without creating duplicates.
3. Compare the imported distinct-account total with the county source total and
   resolve rejected or duplicate rows.
4. Configure and validate the county-specific parcel GIS source. The account ID
   is the join key; Census may fall back to a situs address, but parcel geometry
   still requires a compatible county parcel source or a manual-review path.
5. Run the Census and parcel-context maintenance queues, then confirm county
   coverage and review counts independently.

Do not describe Census or parcel coverage as "all DFW" until Dallas, Collin,
Denton, Tarrant, Rockwall, and every other county in the intended product scope
has passed this inventory reconciliation.

## Safety and failure behavior

- A PostgreSQL advisory lock prevents overlapping scheduled runs, including a
  manual run that overlaps a Render schedule.
- Census and sale-coordinate jobs have bounded batch counts. The overall job
  also has a maximum runtime checked between tasks and batches.
- Imports upsert new data. A failed remote source does not erase the most recent
  successful local data.
- Every acquired run writes a row to `app.scheduled_maintenance_runs` with its
  tasks, results, finish state, and error summary.
- Queue leases and retry limits remain active. Individual failures are retried or
  moved to manual review without failing a property-report request.

## Acceptance and monitoring

`GET /api/system/performance` returns:

- whether either inline bulk worker is enabled;
- a bounded rolling request window with p50, p95, maximum, error count, and
  normalized slow routes;
- current PostgreSQL pool totals, idle connections, and waiters;
- recent scheduled-maintenance results.

Production acceptance targets for the stabilization pass:

1. Both inline workers report `false`.
2. A routine scheduled run finishes (or safely skips because another owns the
   lock) and appears in maintenance history.
3. The subject account API remains below the 750 ms warning target under normal
   traffic, with zero pool waiters.
4. Property-report subject identification renders before neighborhood analysis;
   the deferred section loads as it approaches the viewport or when its button
   is selected.
5. Direct browser printing forces deferred sections to mount. The separate Full
   Appraisal PDF route continues to render its complete report and E&O checks.
6. Server tests, frontend checks, and a production frontend build pass before
   deployment.

Final appraisal E&O preflight is intentionally on-demand. It loads the durable
workfile and current property evidence only when the appraiser selects Finalize
& Lock, so unresolved scraper-repair warnings remain visible without adding
queries to initial Property Report rendering.


## Data-repair readiness and import bursts

GET /api/system/data-repair is the aggregate operational view for this work. It
does not mutate a property and it never returns account identifiers. It combines:

- normalized web request timing and PostgreSQL pool pressure;
- the latest Census, sale-coordinate, influence, and sales-reconciliation queue
  snapshots from scheduled-maintenance history;
- cached Dallas County scraper campaign, outage-circuit, owner, market-value,
  field-repair, legacy-reconciliation, and manual-review counts;
- a compact action_items list and a healthy, attention, or degraded status.

The scraper request runs only when this operational endpoint is requested,
times out independently, and is cached for five minutes. A source outage keeps
the last successful snapshot and marks it stale rather than slowing property
reports or removing known data.

Routine maintenance now has enough bounded capacity to drain up to 10,000
location rows and 10,000 influence rows per run, subject to the existing
45-minute deadline. Queue ordering still prioritizes the newest sale activity.
After a large CSV import, run the background-only burst command:

    npm run maintenance:sales

This command processes locations and influences without running Census, parcel,
road, flood, zoning, or document work. When Trestle replication is enabled, its
background job automatically runs the same bounded sales-enrichment pass after
each successful feed sync. Trestle ingestion remains durable even if enrichment
fails; the next run resumes the queue.
## Rollback

If the scheduled service is unavailable, temporarily set the affected inline
worker flag to `true` and redeploy the web service. Remove the flag after the
scheduled job is restored. The lazy report section can be rolled back
independently without changing APIs or stored data.

## Maintenance changes

When adding a new scheduled data source:

1. Make the importer idempotent and preserve last-known-good records on failure.
2. Add it as an independent task in the scheduled-maintenance registry.
3. Add a bounded runtime or page/batch limit.
4. Record a concise result in the maintenance run details.
5. Test failure and overlap behavior before adding the Render schedule.
