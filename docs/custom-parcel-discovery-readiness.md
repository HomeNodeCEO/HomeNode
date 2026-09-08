# Custom parcel discovery readiness audit

`auditCustomParcelDiscoveryReadiness(connection)` is an internal, read-only maintenance audit of the existing
`gis.dcad_parcels` cache. It is not wired to any route, request/page-load path, producer, or permission callback. Pass a
pinned PostgreSQL client you own, with a trusted PostGIS search path and appropriate read access. The caller must
arrange a stable maintenance snapshot (normally a caller-owned repeatable-read transaction) and exclude concurrent
schema changes; the audit never begins, commits, rolls back, releases, or closes anything. Query failures propagate
unchanged, including malformed geometry errors. Connection settings, statement timeouts, and handling database notices
remain the caller's responsibility.

The audit reads table/column catalog facts first. It requires actual ordinary/partitioned tables, the extension-owned
PostGIS geometry type, text account/hash fields, UUID sync references, and no active row-level filtering on either
relation. Missing/incompatible dependencies return `status: "incomplete"`, with null counts—not fabricated zero defects.
Changed relation OIDs and malformed query results throw. Counts require a full local scan, including every coordinate;
run only in an approved maintenance window.

All row counts remain exact nonnegative int64 decimal strings. Counts cover null, empty, invalid, non-MultiPolygon,
non-4326, nonfinite X/Y/Z/M, and finite coordinates outside WGS84 longitude/latitude limits. Categories can overlap; do
not sum them as distinct bad parcels. Null/blank account identifiers mean only missing identifier linkage, not failed
matching against an authoritative account inventory. Hash presence is not hash authenticity. Sync checks separately
count null and dangling UUID references and their union against `gis.source_sync_runs.id`; an existing run does not
prove completeness, freshness, successful ingestion, provider authority, or geographic coverage. No owner, parcel
attributes, or MLS records are returned. No malformed geometry is cast to geography, repaired, or deleted. An empty
cache is blocked.

Index facts come from indexes attached to the actual table OID, not a trusted index name. A qualifying index must be
valid, ready, live, nonpartial GiST with exactly one expression key and no included columns, the PostGIS-extension-owned
`gist_geography_ops` operator class, and an exact conservatively recognized deparse of `(geom)::geography` (possibly
qualified with the actual PostGIS geography namespace). Arbitrary expressions, geometry GiST indexes, typmod casts,
additional wrapping/functions, and unknown expression spellings do not establish the exact index. This conservative
match can yield false negatives; it must not be widened by name-based assumptions. At most 32 index fact objects are
returned, qualifying candidates first, with expression/definition limits of 1,024/2,048 characters and explicit
truncation indicators. Total index count is exact text. No index or other database object is installed.

`auditComplete` means these aggregate checks ran, not that production is approved. `cachePrerequisitesSatisfied`
requires a nonempty, defect-free cache and an established exact expression index. `productionReady` is always false and
authoritative coverage is always `not_established`: cached metadata cannot prove the source universe. Source-origin
admission, the real producer and authorized issuer, and native PostgreSQL/PostGIS verification remain required before
activation.

The future whole-parcel query is `ST_DWithin(geom::geography, validated_subject_point::geography, 4828.032, true)`. Its
origin is the validated subject point, **not** the nearest edge of the subject parcel. This module neither executes that
query nor admits an origin. Unit mocks verify contract handling, count precision, bounded metadata and read-only
statements; they are not native PostgreSQL/PostGIS evidence or query-plan evidence. Native checks must exercise actual
malformed/empty/out-of-range/incorrect-SRID geometries, absent metadata links, the real catalog expressions and operator
class, exact boundary behavior and query-plan/index suitability. Foundation owns native verification, independent review
and integration. Existing publication protections remain unchanged.

Schema provenance: `server/src/services/propertyContextStore.js` declares `gis.dcad_parcels.account_id` (113–115),
`source_record_hash`/`sync_run_id` (136–140), MultiPolygon/4326 `geom` (141–145), the existing geometry-only GiST index
(151–153), and `gis.source_sync_runs.id` (79–80), inspected through the `foundation-discovery` index at base
`dff1a10393d70d5fce396f58689e843f18dc1b84`.
