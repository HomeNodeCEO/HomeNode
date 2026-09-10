# Sales retention audit and historical import receipts

## This slice: a read-only audit, not deletion

The audit reports stored sales against an explicit calendar-year retention window. The proposed routine window is **the current year plus five completed years**. For `--as-of=2026-09-10`, retain 2021 onward in that routine window; a sale dated before January 1, 2021 is outside it. This is a product retention proposal, not a legal-retention determination or permission to purge evidence.

An outside-window count is not a deletion list. Missing or ambiguous dates and non-closed listings are excluded from dated closed-sale candidates; their absence from the candidate count does not mean they are absent from the database. Import time is not a substitute for sale date. Duplicates, uncertain source meaning, and linked historical evidence need separate review.

The command neither deletes nor archives records, changes matching, runs maintenance, rewrites source profiles, or changes a Custom Appraisal selection. It invokes `auditSalesRetention(pool, options)` only. It does not schedule expiration or enable a purge job.

## Running the command

From `server`, with the existing `DATABASE_URL` configured in the authorized environment:

```text
node scripts/auditSalesRetention.js --as-of=2026-09-10
node scripts/auditSalesRetention.js --as-of=2026-09-10 --sample-limit=10
```

`--as-of` is required and must be a real, zero-padded `YYYY-MM-DD` date, with year at least `0006` so that all five preceding years are representable. There is no implicit system-clock default. `--sample-limit` defaults to `0` and accepts whole numbers from `0` through `50`. The parser rejects duplicate, malformed, and unknown arguments before loading environment configuration or creating a connection. Date and sample options affect reporting only.

Successful output is JSON on stdout, emitted after the audit and pool shutdown succeed. Exit code `2` means invalid command arguments; `1` means configuration, connection, audit, or shutdown failed. Failures print a fixed error code, not the database URL, credentials, SQL error, or exception stack. A failure is not a successful empty audit. The command does not retry automatically.

The connection pool is limited to one connection, with a five-second connection timeout, a five-second statement timeout, a six-second client query timeout, and bounded idle timeouts. The service's default lock timeout is one second. These are per-operation limits, not a claim that every audit must finish in five seconds. The pool is closed in `finally`, including unsuccessful audits.

The service requires the installed driver's documented [transaction-status API](https://node-postgres.com/apis/client#clientgettransactionstatus). It accepts only an idle connection before `BEGIN`, verifies the actual repeatable-read/read-only settings and local UTC/search path, and checks transaction state again before and after commit. A connection leaked with an active or failed transaction is rolled back and discarded without running the inventory; unknown state is discarded without SQL. This prevents the audit from committing someone else's unfinished writes.

Remote connections require TLS certificate and hostname verification. Ordinary `postgres://` and `postgresql://` URLs are accepted. `sslmode=require` is upgraded to explicit verified TLS; `sslmode=verify-full` and equivalent `ssl=true`/`1` also verify. Plaintext is permitted only for literal loopback hosts (`localhost`, `127.0.0.1`, `[::1]`). Conflicting TLS flags, verification-disabling modes, and unsupported URL query overrides are rejected; options cannot silently replace the pool's host or timeouts. Custom certificate URL parameters are not supported by this CLI. Do not work around a certificate error by disabling verification. No environment-variable names or stored configuration are changed.

Keep audit output in authorized operational storage. A nonzero sample limit may expose internal row identifiers; do not publish samples or workfile evidence to a public issue or repository. Default aggregate-only output avoids requesting row samples.

## Reading the inventory

`cohorts.lanes` separates source-linked canonical rows, legacy canonical rows without a source reference, and source-only records. Counts are decimal strings to preserve PostgreSQL bigint precision. These are row counts, not a claim that each row is a distinct real-world transaction. A closing-date disagreement, missing source, non-closed record, or missing/nonfinite date is reported separately instead of silently assigned to the older-sales group.

`distinct_review_source_records` counts each qualifying source once and excludes sources with any conflicting or otherwise ineligible linked canonical row. Dependency counts use that set, so multiple parcel/media/review records cannot multiply the sales counts. Samples are a bounded selection of old rows for inspection, never a deletion manifest.

`schema_inventory` and `issues` expose missing tables, incompatible columns or identities, filtered row access, and unmeasured dependencies. Missing coverage has null counts, not fabricated zeros. Actual foreign-key actions and triggers are reported without executing their effects. Global report/photo hold counts do not establish which sale rows are protected.

Even a complete inventory leaves `protection.coverage` as `not_established` and `reclaimable_bytes` as null. Row counts cannot prove recoverable disk space, and a completed read-only audit does not authorize deletion. A timed-out or failed query produces no partial success report.

## Tests

The ordinary server suite covers the service and import-safe CLI without database access. The additional `salesRetentionAudit.integration.test.js` test is explicitly opt-in using `SALES_RETENTION_AUDIT_DATABASE_URL` and `NODE_ENV=test`. It requires a caller-created, empty, loopback database named `sales_retention_<32 lowercase hex characters>_test` and verifies the actual connection before creating synthetic fixtures. It refuses existing `app` or `core` schemas, never falls back to `DATABASE_URL`, and does not create/drop databases or start services.

That test harness intentionally writes its own synthetic fixtures to test date cutoffs, dependency multiplicity, snapshot consistency, and unchanged records. The audit under test remains read-only. Never point the harness at a production, staging, or shared development database; it is not the operator audit command.

## Protection decisions remain unresolved

Before any deletion proposal can become executable, establish at least:

- Which signed reports, accepted assessments, retained captures, attachments, import receipts, and evidence references depend on a row or its original source.
- Which records are assignment-private historical supplements rather than an ordinary rolling shared mirror.
- Applicable source-provider rights, contractual retention obligations, holds, backup/recovery requirements, and authorization for destructive operations.
- What happens to canonical sales, source rows, parcel matches, retained snapshots, and repeat sales when one linked record is removed.

This audit does not establish that those protections are satisfied. No count authorizes bypassing them, and this slice introduces no evidence-purge mechanism.

## Planned: assignment-private historical CSV supplements

The historical-supplement workflow below is **planned, not implemented by this audit**. Existing import functionality does not by itself provide this complete workflow.

An appraiser should be able to add an older sales file to a particular assignment, retain its original evidence and declared provenance, and reuse shared normalization and property-matching logic. Its assignment-private scope must not silently turn it into a shared current-market feed. Unknown currency, units, closing consideration, and historical property characteristics must stay unknown unless the retained source and review establish them.

Each import needs a committed row receipt, separate from both property matching and the selected analysis:

| Stage | What its receipt or result must establish |
| --- | --- |
| Ingestion | Original file/batch identity and row position; committed normalized/source row identifiers; accepted, duplicate, rejected, or failed disposition and reason. A receipt must not claim persistence before the transaction commits. |
| Matching | Matched, unresolved, ambiguous, or conflicting property identity, with the matching basis and review outcome. A committed row can remain unmatched. |
| Analysis | The exact assignment, retained context, period, and selected pocket/property set; included or excluded disposition and reasons. A valid match is not automatic eligibility or selection. |

The UI should distinguish “saved to this file,” “matched to a property,” and “included in this analysis.” Reopening a file must retain those distinctions. Re-importing the same file should not fabricate duplicate committed receipts, discard unresolved rows, or imply that every parsed row entered the statistics.

Older assignment evidence must not expire immediately because its sale date falls outside the routine shared-mirror window. Inclusion and exclusion change the selected analysis; they do not purge the original uploaded file, receipts, or retained observations. Any eventual retention or deletion mechanism must respect those evidence dependencies separately.
