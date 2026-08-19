# Trestle integration and activation plan

This integration is intentionally disabled until HomeNode has an executed
Trestle agreement, the MLS scope is known, and credentials are stored as Render
secrets. It is separate from the Dallas County scraper and must never be added
to that scraper's web process.

## What is ready now

- OAuth2 client-credentials authentication with an in-memory token cache.
- Configurable Cotality/Trestle base and token URLs.
- Metadata retrieval and a metadata hash for schema-change monitoring.
- Incremental Property polling by `ModificationTimestamp` with durable
  `@odata.nextLink` and watermark state.
- Bounded pages, timeouts, retries, and `Retry-After` handling for quota or
  transient server responses.
- A raw, idempotent provider mirror keyed by the unique `ListingKey`.
- A durable post-ingest queue that matches provider records only to existing CAD
  accounts. Provider records never create a replacement canonical CAD account.
- A county/parcel/address match cache so most joins are database-only. Database
  triggers keep it current after the one-time bootstrap as accounts or cached
  locations change.
- Immediate storage of licensed provider coordinates and source-attributed
  property observations. Official DCAD coordinates retain priority in Dallas.
- Automatic Dallas County location queueing when a matched provider record has
  no usable coordinates.

Run commands (after credentials and contract approval):

```text
npm run sync:trestle
npm run maintenance:locations
```

Recommended first deployment: a separate Render cron job every 5-15 minutes.
Keep `TRESTLE_ENABLED=false` on the web service. The sync job is restartable and
retains the last successful cursor and all last-known-good raw records.

## Mandatory activation checklist

The following are **must-do items before setting `TRESTLE_ENABLED=true` in
production**. Do not treat the current preview/raw sync as a complete live feed.

1. Confirm contract coverage, allowed MLS organizations, field/media rights,
   retention rules, display attribution, and whether sold data can be persisted.
2. Obtain a sample feed first. Save `$metadata`, confirm `Property`, `Media`,
   Lookup/Field resources, and compare the metadata hash after every deployment.
3. Confirm the exact NTREIS `OriginatingSystemName` values. Never assume one
   system-name string covers all DFW records.
4. Validate the feed's fields for parcel ID, address, county, coordinates,
   statuses, dates, prices, concessions, financing, physical characteristics,
   CLIP/UPI if licensed, and deletions/status changes.
5. Finish the idempotent canonical mapper in `providerIngestion.js`: upsert
   `core.sales_source_records`, `core.sale_parcels`, and `core.sales` by
   `ListingKey`, without overwriting manually verified account links or manual
   property values.
6. Finish Media synchronization: query `Media` by
   `ResourceRecordKey = ListingKey`, preserve `Order`, permissions and
   modification timestamps, and upsert `core.sales_source_media`. Do not copy or
   redistribute images unless the agreement permits it.
7. Decide how deletions, expired listings, withdrawn listings, re-listed
   properties, multiple parcels, and cross-MLS duplicate listings are retained.
8. Run an acceptance sample against manually verified Dallas, Collin, Denton,
   Tarrant, and Rockwall records. Record match precision, duplicates, address
   fallback rate, coordinate coverage, and manual-review rate by county.
9. Add alerts for failed syncs, a stale watermark, metadata hash changes,
   quota exhaustion, growing post-ingest backlog, and manual-review volume.
10. Only after the above: schedule the sync, then drain existing raw/provider
    queues before relying on live Trestle data in appraisal reports.

## Intended resolution rules

For physical characteristics, the application continues to use:

1. Appraiser-saved/manual verified value.
2. Licensed Trestle/MLS observation.
3. CAD value when the specific Trestle field is absent.
4. Manual review if both sources are empty.

CAD remains authoritative for appraisal-district identifiers, assessed/market
values, exemptions, ownership, legal description, and tax history. A Trestle
parcel number or address is evidence for matching; it does not silently replace
the CAD account ID.

## Scaling path

Short term, every CSV import automatically queues its matched Dallas accounts
for the existing batched location worker. Large imports use the bounded drain
command. Long term, refresh `app.parcel_match_cache` after every county CAD-roll
load and periodically after location maintenance. Trestle records then match in
PostgreSQL first; only true misses reach county GIS or manual review.

Trestle documentation notes used by this design:

- The service is RESO Web API/OData and metadata-driven.
- `ListingKey` is the unique Property identity; `ListingId` is not guaranteed
  unique.
- `@odata.nextLink` is the pagination mechanism, with 1,000 records as the
  normal per-query maximum.
- Large replications use `replication=true`; replication links expire after
  five minutes of inactivity, so that mode must be handled by a dedicated
  uninterrupted bootstrap job rather than the normal incremental cron.
- Media is related by `ResourceRecordKey` and ordered by `Order`.
- OAuth tokens last up to eight hours and should be cached.
