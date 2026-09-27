# Custom neighborhood performance review — 2026-09-27

Disposition of the supplied Claude sweep against main `ba7c33a7`. The earlier
broader review used `b64453c`, before the manifest/viewport transport in #971.

## Changes in this slice

- **Verified cache reads:** recheck stored text digest/size and database-computed
  compressed-byte SHA-256; return this metadata instead of compressed payloads
  on hot hits. A mismatch falls back to bounded decoding; missing rows cannot
  use a cache value. This saves transfer and Node hashing, not PostgreSQL hashing.
- **Viewport validation:** retain structural, membership, geometry and exact
  selection/context checks, but omit repeat serialization after the transport's
  decoded-stream byte limit. Reuse membership sets for immutable checked inputs.
- **Camera changes:** reuse a complete successful viewport only for contained
  bounds with the same catalog, map manifest, target, context and selection.
  Failed, unavailable, stale or partial responses cannot satisfy a new view.
  A newly accepted selection can restyle that complete geometry without another
  download when its frozen catalog/manifest and exact target/context are still
  identical. Pending editor choices cannot do this; coordinate identity stays
  unchanged and late responses for previous selections are discarded.
- **Parcel display regression:** the overview zoom gate introduced by viewport
  loading hid the actual parcel coverage. Keep the clickable subdivision dots
  and restore exact parcel polygons, similarity fills and red inclusion outlines
  beneath them at overview too, per the user's clarified display preference.
  Dense views may be split into bounded sequential requests, using the existing
  per-response ceiling. Points complement, never replace, the parcel coverage.

Authorization, statistics, observation dates, report Apply, original retained
evidence, database schemas and process-cache memory limits are unchanged.

## Reconciled recommendations

- **Year-long immutable map HTTP caching:** do not adopt as proposed. A fresh
  browser cache hit would skip server access/policy rechecks. #971 already avoids
  transferring the complete map with the initial catalog response. Server-side
  map decoding and manifest projection still need separate measurement.
- **Heavy/light concurrency lanes:** worthwhile follow-up, but route names or
  `include_map:false` cannot classify cost: a prepared-cache miss can reconstruct
  the retained graph and prepare a full map. Separate hit and preparation paths
  before changing admission. Do not raise concurrency to hide slow work.
- **Copy/freeze removal:** normal viewport openings avoid the legacy full-map
  clone path. Preserve defensive handling of unknown/injected values and frozen
  server maps, whose immutability certifies cached bounds and byte counts.
- **Inspection/recoloring:** the renderer already uses feature state. Further
  reduction of wrappers/collection walks should be measured on visible parcels;
  inspection must not rebuild coordinates or replace the data source.
- **Preparation serialization reuse:** valid cold-path follow-up. Reusing exact
  serialized features must preserve UTF-8 limits, selection neutrality and digest
  identity. It is not the primary source of repeated hot-read latency.
- **Coordinate rounding:** not included. Display simplification needs an explicit
  separate design; retained parcel geometry must remain unchanged.
- **Request-body sizing:** keep the router guard. An upstream JSON parser can
  accept a larger body before the router's own parser sees it; the integration
  suite explicitly tests this. Content-Length alone is not equivalent.

## Remaining measurement limits

A dense map of about 29.6 MB exceeds the unchanged 24 MB hot-map budget; it can
still be decoded on later requests. The numeric hot cache and bounded viewport
transport do not establish instant end-to-end opening. Measure cold opening,
warm opening, dense overview completion and selection clicks separately. Do not
claim a production speedup from synthetic tests alone.
