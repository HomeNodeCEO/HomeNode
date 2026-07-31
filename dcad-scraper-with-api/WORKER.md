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
7. A detail page is counted as successful only when it contains a situs
   address or market value and does not report `No Data`. Invalid responses are
   rejected before the separate history request, so the check does not add a
   network round trip to healthy accounts.
8. After three incomplete responses while DCAD's known-good health account is
   available, the worker searches the source address. A single exact
   address/city/ZIP match is scraped and recorded as the canonical account.
   Missing or ambiguous matches remain in the manual-review queue.
9. One address-recovery item is processed per 25 normal campaign accounts by
   default, limiting its effect on normal throughput.

The residential target table—not `core.accounts.county`—controls selection.

## Data-quality recovery

Apply the source-address backfill before seeding the recovery queue. Both tools
default to rollback-only validation:

```powershell
python tools/backfill_account_search_fields.py "C:\path\to\DCAD Accounts.csv"
python tools/backfill_account_search_fields.py "C:\path\to\DCAD Accounts.csv" --apply
python tools/requeue_incomplete_dcad_accounts.py
python tools/requeue_incomplete_dcad_accounts.py --apply
```

The requeue tool performs the one-time historical scan outside worker startup.
It reopens prior successes whose newest snapshot has neither address nor market
value, creates legacy reconciliation items for Dallas accounts outside the
authoritative target list, and applies the frontend review flags. Resolved
legacy IDs remain as aliases to their canonical IDs for auditability.

Relevant optional worker settings are:

- `SCRAPE_RECOVERY_ATTEMPTS` (default `3`)
- `SCRAPE_RECOVERY_EVERY_ACCOUNTS` (default `25`)
- `SCRAPE_HEALTH_ACCOUNT_ID` (default `26272500060150000`)

## Property-search metadata

The HomeNode property search uses indexed `street_name`, `city`, and
`postal_code` fields on `core.accounts`. Populate or refresh them from the DCAD
account export with a rollback-only pass followed by the committed pass:

```powershell
python tools/backfill_account_search_fields.py "C:\path\to\DCAD Accounts.csv"
python tools/backfill_account_search_fields.py "C:\path\to\DCAD Accounts.csv" --apply
```

The tool updates existing accounts only. Dallas metadata comes from the export;
for accounts outside that file, it derives the fields from an existing formatted
`street, city, state zip` address when available.
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

## MLS photos

The property/sales export must include `ListingKey` (preferred) or `ListingId`
so a separate RESO Media export can be attached to the correct transaction.
The media CSV must contain:

- `ResourceRecordKey` (matching the property export's `ListingKey`) or
  `ResourceRecordID` (matching `ListingId`)
- `MediaURL`
- `Order`
- `PreferredPhotoYN`

`MediaKey`, `ClassName`, `MIMEType`, `ShortDescription`, `Permission`, and
`ModificationTimestamp` are optional but preserved when present.

Validate the media export without changing the database:

```powershell
python -m dcad.import_sales_media "C:\path\to\media.csv" --dry-run
```

Load or refresh galleries:

```powershell
python -m dcad.import_sales_media "C:\path\to\media.csv"
```

Use `--replace` only for a complete media export. It removes the prior gallery
for each matched listing before loading the replacement rows. The frontend uses
the preferred photo first, then the MLS `Order`, and fetches the remaining
gallery only after a user opens a photo.

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
```
