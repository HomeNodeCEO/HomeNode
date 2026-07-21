# Continuous Dallas CAD scraper worker

The worker in `scraper/dcad/worker.py` continuously refreshes known Dallas CAD
accounts in PostgreSQL. On Render it shares the existing paid web-service
instance with the FastAPI application; `scraper/service_runner.py` supervises
both processes and stops the service if either process exits unexpectedly.

## Scheduling behavior

1. Existing successful scrapes are bootstrapped from `core.dcad_json_raw`.
2. Known accounts without a successful scrape are processed first.
3. Failures receive exponential backoff, capped at seven days, so one invalid
   account cannot block the queue.
4. After the backlog is complete, the oldest successful account is refreshed
   when it reaches `SCRAPE_REFRESH_DAYS` (30 days by default).
5. A database lease makes restarts safe and prevents multiple workers from
   processing the same account simultaneously.

Accounts labeled `Collin` are excluded by default because the page fetcher uses
Dallas CAD URLs. Accounts with a missing county remain eligible because many of
the previously scraped Dallas records have no county label.

This worker refreshes accounts already present in `core.accounts`. Discovering
brand-new DCAD account IDs is a separate ingestion task.

## Local commands

Run these commands from `dcad-scraper-with-api/scraper` with `DATABASE_URL` and
`DB_SCHEMA=core` configured:

```powershell
python -m dcad.worker --migrate-only
python -m dcad.worker --once
python -m dcad.worker
```

`--once` is the safest smoke test. It processes at most one due account.

## Render deployment

The existing `dcad-scraper-with-api` Render web service builds this directory's
`Dockerfile`. The image starts both the public API and the continuous worker by
default. Set `RUN_DCAD_WORKER=false` only when the API must run by itself.

Set `DATABASE_URL` to the database's **internal** Render URL. Do not commit the
URL to Git. The service also expects `DB_SCHEMA=core` and uses
`SCRAPE_STATE_SCHEMA=app` by default.

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
```
