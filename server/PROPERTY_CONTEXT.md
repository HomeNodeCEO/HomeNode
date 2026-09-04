# Property Context and Complexity

HomeNode evaluates property complexity from local database records so opening a
report or ranking comparable sales never depends on an external GIS service
responding at that moment.

## Phase 1 sources

- Dallas CAD parcel polygons and parcel attributes:
  `Property/ParcelQuery/MapServer/4`
- Census TIGERweb primary, secondary, and local road layers:
  `Transportation_LargeScale/MapServer`
- Existing HomeNode property characteristics and appraiser-defined market area

The local mirror supports site-size percentiles, parcel configuration,
commercial/multifamily adjacency, nearby external influences, corner-lot
screening, and major-road proximity. Existing property records provide GLA,
age/year built, pool, and additional-amenity factors.

## Failure behavior

Synchronization writes are upserts. A failed or incomplete refresh marks the
source failed but does not delete the last successful local data. The API
reports source freshness and the UI warns the appraiser when stale data is in
use. Property reports, present-land-use analysis, and comparable search remain
available from the last local snapshot. A full Dallas CAD refresh must return
at least 100,000 object IDs before old records can be removed. Every full
refresh must also fetch, normalize, and write one valid feature for every
advertised object ID before cleanup is allowed.

Each source refresh holds a PostgreSQL advisory lock on one dedicated
connection. A second invocation for the same source exits successfully with a
bounded `property_context_sync_already_running` result instead of overlapping
the active refresh. Checkpoint, success, and failure updates are bound to the
active run ID so an older worker cannot replace a newer source status.

Boundary land-use results are cached both in memory and in PostgreSQL. If the
live fallback fails before the local mirror has been initialized, the most
recent saved result for the exact subject and polygon can still be returned.

## Commands

Initial load:

```sh
npm run sync:property-context:full
```

Incremental Dallas parcel refresh:

```sh
npm run sync:property-context -- --source=parcels --mode=incremental
```

Full TIGER road refresh:

```sh
npm run sync:property-context -- --source=roads --mode=full
```

Recommended production schedule:

- Dallas parcels: nightly incremental refresh
- TIGER roads: monthly full refresh, plus an annual refresh when a new vintage
  is published
- Initial full load: run once before relying on GIS-derived factors

`GET /api/property-context/status` reports the local source row counts,
freshness, last error, and whether stale data is being served.

## Complexity workflow

1. The backend saves the automatic evidence, score, confidence, and recommended
   geography/complexity search profile.
2. The Property Report lets the appraiser confirm or override the determination
   without rewriting the automated evidence.
3. The Sales Comparison page recalculates from local data, respects the latest
   assignment-file override, and preselects the recommended search profile.
4. The appraiser may still select another profile before ranking sales.

## Deferred validation work

The comparable-ranking formula intentionally remains unchanged in Phase 1.
`server/src/util/comparableScoring.js` contains the tracked
`TODO(property-context-ranking)` marker. After testing representative simple,
moderate, and complex assignments, complexity may tune candidate radius,
similarity tolerances, or weights without changing the saved automatic
complexity evidence.

Phase 2 source work includes TxDOT traffic counts, municipal zoning overlays,
FEMA flood information, and any additional influence layers selected after
source/licensing validation.

## Municipal zoning synchronization

Municipal zoning is synchronized into the local PostgreSQL mirror and is not
queried during report rendering. This keeps the Property Report usable when a
city GIS is unavailable. The bounded Dallas County batch currently used for
the next rollout is:

- Balch Springs
- Carrollton
- Cedar Hill
- Coppell
- DeSoto
- Duncanville
- Farmers Branch
- Grand Prairie

Run only this batch without touching the already-validated Dallas and Garland
sources:

```sh
npm run sync:property-context -- --source=zoning --mode=full --jurisdictions="Balch Springs,Carrollton,Cedar Hill,Coppell,DeSoto,Duncanville,Farmers Branch,Grand Prairie"
```

The same comma-separated list may be passed to scheduled maintenance with
`MAINTENANCE_ZONING_JURISDICTIONS`. A failed city refresh is isolated, recorded,
and does not remove the last successful local snapshot for that city.

Cities without a verified queryable GIS source remain manual-review sources.
Their official map/code URL, planning contact, and cached official PDF (when
the city exposes one that can be downloaded reliably) are returned in the
Property Report. Machine-extracted zoning wording is always a suggestion until
an appraiser confirms it.
