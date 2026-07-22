# Continuous Dallas CAD scraper worker

The worker in `scraper/dcad/worker.py` continuously refreshes known Dallas CAD
accounts in PostgreSQL. On Render it shares the existing paid web-service
instance with the FastAPI application; `scraper/service_runner.py` supervises
both processes and stops the service if either process exits unexpectedly.

## Scheduling behavior

1. `app.dcad_residential_targets` is the authoritative Dallas residential list
   and preserves the source CSV row order.
2. The initial phase processes only target IDs that had no raw scrape when the
   campaign was loaded.
3. When every initially missing target succeeds, the worker records an
   `initial_missing_complete` event and begins full-list cycle 1 at the top of
   the CSV.
4. Full-list cycles continue in source order. Completing the final target
   records a `full_cycle_complete` event and immediately starts the next cycle.
5. Failures receive exponential backoff, capped at seven days. Other targets
   continue while a failed account waits, but a phase or cycle is not declared
   complete until every target has succeeded.
6. A database lease makes restarts safe and prevents multiple workers from
   processing the same account simultaneously.
7. Five consecutive DCAD connection, timeout, rate-limit, or server failures
   open a shared outage circuit. The campaign pauses for five minutes, allows
   one leased recovery probe, and resumes automatically after a successful or
   otherwise reachable DCAD response. Invalid-property and database errors do
   not count as DCAD outages.

The residential target table—not `core.accounts.county`—controls selection.
Collin County rows already present elsewhere in the database have no effect on
this campaign.

## Local commands

Run these commands from `dcad-scraper-with-api/scraper` with `DATABASE_URL` and
`DB_SCHEMA=core` configured:

```powershell
python -m dcad.worker --migrate-only
python -m dcad.import_residential_targets "C:\path\to\DCAD Accounts.csv"
python -m dcad.import_sales "C:\path\to\sales.csv" --source-name "Garland MLS two-year sales" --dry-run
python -m dcad.worker --once
python -m dcad.worker
```

See `SALES_IMPORT.md` for the full sales-source, parcel-link, and enriched-view
contract.

`--once` is the safest smoke test. It processes at most one due account.

## Render deployment

The existing `dcad-scraper-with-api` Render web service builds this directory's
`Dockerfile`. The image starts both the public API and the continuous worker by
default. Set `RUN_DCAD_WORKER=false` only when the API must run by itself.

Set `DATABASE_URL` to the database's **internal** Render URL. Do not commit the
URL to Git. The service also expects `DB_SCHEMA=core` and uses
`SCRAPE_STATE_SCHEMA=app` by default.

The outage circuit defaults can be tuned with
`SCRAPE_OUTAGE_FAILURE_THRESHOLD` (default `5`) and
`SCRAPE_OUTAGE_PAUSE_SECONDS` (default `300`). The defaults are intentionally
conservative so an individual bad account cannot pause the campaign.

Campaign progress is available from the public API at `/scrape/status`.

Only one worker instance should run initially. The default request pacing is a
two-second delay after each account, in addition to the one-second pause between
the detail and history requests inside the scraper.

## Monitoring queries

```sql
SELECT status, count(*)
FROM app.dcad_scrape_state
GROUP BY status
ORDER BY status;

SELECT
  min(last_success_at) AS oldest_success,
  max(last_success_at) AS newest_success,
  count(*) FILTER (WHERE last_success_at IS NOT NULL) AS successful_accounts,
  count(*) FILTER (WHERE status = 'retry') AS retry_accounts
FROM app.dcad_scrape_state;

SELECT account_id, attempts, next_attempt_at, left(last_error, 200) AS error
FROM app.dcad_scrape_state
WHERE status = 'retry'
ORDER BY attempts DESC, next_attempt_at
LIMIT 100;

SELECT event_type, cycle_number, event_payload, created_at
FROM app.dcad_campaign_events
ORDER BY event_id DESC
LIMIT 20;

SELECT upstream_failure_count, outage_pause_started_at, outage_paused_until,
       outage_count, outage_probe_worker_id, left(outage_last_error, 200)
FROM app.dcad_residential_campaign
WHERE campaign_key = 'dallas_residential';
```
