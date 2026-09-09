# Retained Custom discovery parcel map

`buildCustomCohortParcelMap({ retained_inputs, selected_account_ids? })` is a pure,
display-only adapter for the internal `retained_inputs` returned by
`loadCustomCohortCaptureInputs`. The caller must first load and verify that graph
and separately establish current access. The adapter neither accepts an HTTP
receipt as authority nor recreates the original acquisition handoff.

An available result contains `geojson` (a FeatureCollection), `counts`, and
`geometry_semantics: current_observed_cached_parcels_not_legal_subdivision_boundary`.
Each feature has its exact text `gis.dcad_parcels:<object_id>` ID and properties
`object_id`, `account_id`, `selected`. Omitted selection annotates all discovery
accounts as selected; an explicit, duplicate-free exact subset annotates only
that subset. An empty subset is allowed. Selection never hides other discovered
parcels or expands discovery through other parcels on the same account. No
similarity score, color, legal subdivision identity, or cohort eligibility is
inferred.

Only original chunks whose `payload.projection.definition.role` is `parcels`
supply geometry. Every `spatial.parcels` ID must match exactly one retained
`record.data.raw_projection` by object ID, account, source-record hash and SHA-256
of the original EWKB bytes. Other same-account parcel IDs are not displayed or
decoded. Browser GeoJSON and approximate geometry are never fallbacks.

The decoder preserves all Polygon/MultiPolygon rings, holes, disconnected parts
and coordinate order. Both EWKB byte orders are supported, including independently
encoded children; the root must explicitly specify SRID 4326 and children must
inherit it or explicitly match it. Only two-dimensional longitude/latitude is
supported. Unsupported geometry/dimensions, nonfinite/out-of-range coordinates,
open/short rings, truncation and trailing bytes fail closed. This decoder checks
structure and byte identity, not topology; the original native spatial reader
performs its own validity checks. No calculation is buffered, repaired, rounded,
reoriented or transformed.

Hard caps are 100,000 discovered parcels, 1,000 source chunks, 100,000 total
source records, 1,000,000 bytes per geometry, 16,000,000 aggregate geometry bytes,
250,000 coordinate pairs, and 16,000,000 aggregate serialized GeoJSON UTF-8 bytes.
Counts are bounded before allocating geometry arrays. Aggregate GeoJSON bytes
include collection framing, feature separators, properties, and every feature.
Any capacity, missing-evidence, identity or decoding failure returns
`{ status: 'unavailable', reason, geojson: null, geometry_semantics }`; never a
partial collection or misleading partial-success counts. Valid empty discovery
has an empty collection. Returned output is deeply frozen and input is untouched.

Verification: `node --test test/customCohortParcelMap.test.js` from `server`.
The focused tests construct EWKB explicitly and use the real cached-row mapper
wrapper; they do not claim native PostgreSQL, provider coverage, or browser/UI
integration evidence.
