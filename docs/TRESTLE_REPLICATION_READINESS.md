# Trestle / RESO replication readiness

HomeNode is prepared to receive licensed Trestle Property and Media data, but
the integration is intentionally disabled until a Trestle contract and feed
credentials are available. No request is sent to Trestle unless both
`TRESTLE_ENABLED=true` and `TRESTLE_REPLICATION_ENABLED=true` are configured.

## Source rules

- `ListingKey` is the durable, unique Property identity. `ListingId` (the MLS
  number) is searchable and stored, but it is not treated as globally unique.
- Incremental Property replication uses `ModificationTimestamp`, a ten-minute
  overlap, idempotent upserts, and the server-provided `@odata.nextLink`.
- The cursor advances only after a page is committed. A failed page is replayed
  safely on the next run.
- HTTP 429 and server failures use bounded exponential retry. Trestle quota
  headers are retained in the run status without exposing credentials.
- Every accepted row retains the exact RESO payload and source timestamps.
- Active, pending, contingent, and other non-closed records remain listings.
  Closed records become canonical sales only when price, date, and a verified
  CAD account are present.
- Unmatched records are preserved for broad market analysis and the existing
  sales reconciliation queue; they are never silently discarded.
- Manually verified CAD links cannot be overwritten by a later feed update.
- Property/photo updates are independent. `PhotosChangeTimestamp` queues media
  refreshes, and `MediaKey` plus `ResourceRecordKey` provenance is preserved.

These choices follow Cotality's official [Getting Started](https://trestle-documentation.corelogic.com/webapi.html),
[Growing to Scale](https://trestle-documentation.corelogic.com/webapi-at-scale.html),
[Property metadata](https://trestle-documentation.corelogic.com/metadata-resource-Property.html),
and [Media metadata](https://trestle-documentation.corelogic.com/metadata-resource-Media.html)
guidance.

## Data precedence and Dallas County isolation

Verified manual values remain first, followed by Trestle/MLS and then CAD for
the non-Dallas property-characteristic workflow. Missing fields enter manual
review. Existing nonblank values are not erased merely because an update omits
a field.

The Dallas County scraping process, queue, endpoints, and dependencies are not
changed by this integration. Trestle may add licensed listing/sale evidence,
but it does not replace or control the Dallas County scrape. Trestle coordinates
are cached only for matched non-Dallas accounts and never overwrite an existing
matched location.

## Activation checklist

Configure these secrets and switches on a dedicated Render scheduled job, not
on the web request process:

```text
DATABASE_URL=<same HomeNode PostgreSQL database>
TRESTLE_CLIENT_ID=<issued by Trestle>
TRESTLE_CLIENT_SECRET=<issued by Trestle>
TRESTLE_ENABLED=true
TRESTLE_REPLICATION_ENABLED=true
TRESTLE_MEDIA_ENABLED=true
```

Optional controls:

```text
TRESTLE_ORIGINATING_SYSTEM_NAME=NTREIS
TRESTLE_COUNTIES=Dallas,Collin,Denton,Tarrant,Rockwall
TRESTLE_PAGE_SIZE=1000
TRESTLE_MAXIMUM_PAGES=25
TRESTLE_INITIAL_LOOKBACK_DAYS=730
TRESTLE_CURSOR_OVERLAP_MINUTES=10
TRESTLE_MEDIA_BATCH_SIZE=10
```

Leave `TRESTLE_COUNTIES` blank when the licensed feed itself is already scoped
correctly. A county list is an optional API filter, not a substitute for the
Trestle contract's permitted data scope.

Run the scheduled command:

```powershell
npm --prefix server run sync:trestle
```

Recommended cadence after the initial load is every 5–15 minutes for Property
updates and the attached bounded Media batch. The first run defaults to a
two-year lookback. Larger initial loads can be advanced over multiple runs by
raising `TRESTLE_MAXIMUM_PAGES` only after observing the feed's quota headers.

## What the job does

1. Acquires a PostgreSQL advisory lock so two jobs cannot ingest concurrently.
2. Reads the last durable Property cursor and applies a small overlap.
3. Fetches ordered RESO Property pages and follows trusted same-service links.
4. Upserts the source inventory by `ListingKey` without duplicating CSV rows.
5. Matches a CAD account by unique parcel identity, then unique exact address.
6. Preserves unmatched listings/sales with review flags.
7. Creates/updates canonical closed sales only when all safeguards pass.
8. Stores source-attributed non-Dallas property-characteristic observations,
   including explicit zero and false values, without overwriting appraiser edits.
9. Caches non-Dallas listing coordinates only when no location is already
   stored, and queues property-influence recalculation.
10. Queues changed photo sets and refreshes their ordered media records.
11. Records counters, cursor position, failures, quota observations, and queue
    health for `/api/enrichment/status`.

## Validation before production activation

- Obtain a Trestle sample or NTREIS feed and inspect `$metadata` for every field
  enabled by the contract.
- Run with a low page count and compare a known set of ListingKeys, statuses,
  parcel IDs, prices, dates, and photos against Matrix.
- Confirm no duplicate `ListingKey` rows and verify that repeated runs are
  idempotent.
- Test Active-to-Closed transitions and a corrected closed listing.
- Test a repeated MLS number from two source systems; both ListingKeys must be
  retained.
- Compare matched/unmatched counts and review a sample of address-only matches.
- Verify media permissions and display obligations under the signed agreement.
- Add a periodic full ListingKey reconciliation before treating removal or feed
  disappearance as an automated status change. Until then, HomeNode never
  deletes a prior sale solely because it is absent from an incremental page.

## Deferred contract-dependent work

- Confirm the exact NTREIS fields and enum names exposed by the licensed feed.
- Confirm whether the contract permits local image copying or URL-only use.
- Set the permitted county/source filters and quota-aware Render cadence.
- Run an initial-load reconciliation and a recurring full ListingKey audit.
- Validate display, attribution, retention, and deletion requirements with the
  executed Trestle/NTREIS agreement before enabling client-facing media.
