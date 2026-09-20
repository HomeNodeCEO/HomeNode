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
8. Completed accounts missing owner, land, or GLA can be placed in a separate
   field-repair queue. By default the worker processes one repair after every
   five normal campaign accounts, so repair work remains bounded without
   starving the primary campaign.
   A usable response whose requested fields remain
   unverified is classified as `source_missing` rather than retried forever.
   This legacy status does not prove DCAD omitted the field: a parser or
   persistence gap can produce the same outcome.
9. Every newly successful scrape runs a database-only owner, land, and GLA
   presence check. Any remaining gap is added to the same throttled repair lane;
   the check does not make an additional DCAD request.
10. GLA is not required when every usable CAD land state code describes the
    account as vacant land. Mixed vacant and improved classifications continue
    to require GLA so multi-parcel edge cases are not silently suppressed.
11. GLA is also not required when DCAD has no substantive Main Improvement
    data and the current land value equals the total market value. This covers
    vacant lots that retain a generic residential state code; a positive market
    value and both signals are required to avoid hiding improved-property gaps.
12. Field-level audits retain exact `missing_*` requests alongside the legacy
    owner/land/GLA lanes. A repair succeeds only when every requested field is
    present in normalized data and in a parsed snapshot written since the
    repair claim. Year-indexed owner, party, land, legal, and value records are
    matched to that snapshot year. Unknown requests stay unresolved.
    Improvement-only obligations, including an explicit `missing_gla`, may be
    marked not applicable only when the fresh parsed snapshot and normalized
    data independently agree the parcel is vacant without contradictory
    structure/value or mixed-code evidence. This is not a claim that the field
    is present. Requests added during a fetch remain pending for another check.
13. Fresh parsed evidence is not original HTML or per-field provenance, and an
    overlapping scrape can write the latest snapshot. Presence verification
    does not certify value equality or prove which scrape repaired a field.
    Existing historical success/source-missing rows are not bulk reset by a
    worker deployment; a reviewed, separately applied audit is needed to
    requeue them. No repair lease/scheduling policy is changed by these checks.
14. A response that repeatedly fails the same identity/shape validation three
    times is moved to `manual_review`. Its target remains unfinished, it is not
    silently skipped, and the worker will not reclaim it until an operator
    explicitly requeues that account. Network and timeout failures continue to
    use the shared outage circuit instead of this per-account quarantine.
15. A read-only parser canary runs against the known-good health account every
    24 hours. It requires the subject address, owner, market value, and every
    history section, writes only its canary result, and pauses all campaign and
    repair work after a failure. It retries every 15 minutes and resumes work
    only after the sentinel parses successfully.

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

`SCRAPE_FIELD_REPAIR_EVERY_ACCOUNTS` controls the repair cadence and defaults
to `5`.

`SCRAPE_DETERMINISTIC_FAILURE_ATTEMPTS` controls the identical response-
validation failures required for quarantine and defaults to `3` (minimum `2`).
`SCRAPE_CANARY_ACCOUNT_IDS` is a comma-separated list of exact 17-digit Dallas
account IDs and defaults to `SCRAPE_HEALTH_ACCOUNT_ID` (the Snowmass control).
`SCRAPE_CANARY_INTERVAL_HOURS`, `SCRAPE_CANARY_RETRY_MINUTES`, and
`SCRAPE_CANARY_POLL_SECONDS` default to `24`, `15`, and `60` respectively.

### Bounded exact-field audits

Run the audit from `dcad-scraper-with-api` (one directory above `scraper`):

```powershell
python -m tools.audit_dcad_field_completeness --account-ids 00000000000000001 00000000000000002
python -m tools.audit_dcad_field_completeness --batch-size 100
python -m tools.audit_dcad_field_completeness --batch-size 100 --after-account-id 00000000000000100
python -m tools.audit_dcad_field_completeness --account-ids 00000000000000001 --apply
```

Account-ID and keyset scopes are capped at 500 accounts. Keyset reads select
IDs first, using the target primary key; each subsequent detail query restricts
raw/owner/land/party reads to one account and aligns normalized years with the
latest fetched snapshot. Verify account/year indexes and the scoped query plan
with read-only `EXPLAIN` before a production pilot. All reported counts describe
only the chosen scope; `scope.next_after_account_id` and `scope.has_more` support
deliberate paging. `--limit` caps apply candidates, not reads within the scope.
No worker is started and no campaign completion markers are reset.

The default uses a database-enforced read-only transaction. `--apply` first
audits read-only, then rechecks each selected account under short row locks and
commits one account at a time. Leased or locked work is deferred, pending/retry
attempts and schedules are retained, and requests/quality flags are unioned
without erasing unrelated obligations. Unchanged reruns do not mutate queue
rows. A succeeded row is reopened only for a newly discovered exact field;
already-requested regressions need review. All `source_missing` rows are
deferred, including new omissions, until source-versus-parser review is done.
An error stops the batch, reports earlier committed outcomes and the failing
account, and exits nonzero; a rerun safely skips unchanged queued work.

Stored field omissions are reported separately from parsed snapshot evidence.
Neither missing JSON nor the `source_missing` status proves source absence, and
the audit does not infer land area from dimensions or synthesize owner shares.
Healthy stored fields are not queued just because an older parsed snapshot
omitted them. Vacant/indeterminate parcels are reported, not automatically
queued as improved-property repairs.

`--full-scan` explicitly opts into the legacy, potentially expensive whole
campaign report and cannot be combined with `--apply`. It uses independent
latest-year aggregates and legacy improvement predicates rather than bounded
snapshot-aligned reads. Its omission counts are diagnostic, not an authoritative
enqueue list: queue actions are `not_classified` and selected candidates remain
zero because the report does not fetch queue obligations or parsed snapshots.
All reads default to a 15-second statement timeout. Only an explicit full scan
may opt into `--full-scan-statement-timeout-seconds N` (integer 1-120); bounded
reads and apply transactions always keep 15 seconds. The 1-second lock timeout
and read-only full-scan transaction are unchanged. This timeout applies per SQL
command, including server-cursor `FETCH`, not to the report's total runtime;
raising it does not guarantee the legacy global scan will finish. Prefer
bounded scopes for production pilots. Do not use
the legacy `queue_field_repairs.py` as a read-only probe: its default executes
writes before rollback, its `--limit` does not bound the underlying audit, and
it can reset non-leased retry history.

Campaign progress is available from the public API at `/scrape/status`.
It includes `manual_review_targets` and a `parser_canaries` object. A failed
canary is an intentional stop condition, not a worker outage to work around.

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

SELECT account_id, attempts, consecutive_deterministic_failures,
       manual_review_at, left(manual_review_reason, 200) AS reason
FROM app.dcad_scrape_state
WHERE status = 'manual_review'
ORDER BY manual_review_at, account_id;

SELECT account_id, status, consecutive_failures, last_run_at,
       last_success_at, next_run_at, left(last_error, 200) AS error
FROM app.dcad_parser_canaries
ORDER BY account_id;

SELECT event_type, cycle_number, event_payload, created_at
FROM app.dcad_campaign_events
ORDER BY event_id DESC
LIMIT 20;

SELECT upstream_failure_count, outage_pause_started_at, outage_paused_until,
       outage_count, outage_probe_worker_id, left(outage_last_error, 200)
FROM app.dcad_residential_campaign
WHERE campaign_key = 'dallas_residential';

SELECT status, count(*),
       count(*) FILTER (WHERE 'owner' = ANY(remaining_fields)) AS owner_missing,
       count(*) FILTER (WHERE 'land' = ANY(remaining_fields)) AS land_missing,
       count(*) FILTER (WHERE 'gla' = ANY(remaining_fields)) AS gla_missing
FROM app.dcad_field_repair_queue
GROUP BY status
ORDER BY status;
```
