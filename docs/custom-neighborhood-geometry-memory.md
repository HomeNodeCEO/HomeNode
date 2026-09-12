# Retained parcel geometry memory optimization

The Custom neighborhood proximity calculation uses a compact internal geometry
index instead of constructing and retaining a second complete GeoJSON map. The
map and index share one generator, EWKB decoder, identity/hash verification, and
admission limits. Each parcel's coordinates exist transiently for validation and
exact would-be GeoJSON byte accounting, then only the original EWKB string,
binding fields, and component count remain in the index.

This is a peak-memory optimization, not a smaller API payload or a new evidence
source. Hex EWKB plus hashes can serialize larger than GeoJSON; the index is
owner-internal and is not sent to the browser or added to retained evidence.

## Behavior preserved

- Complete discovery membership, record identities, hashes, literal geometry,
  ring order, holes, and disconnected components remain unchanged.
- Full map output, native distance SQL/parameters, sorted fingerprints, and
  proximity results remain unchanged. The source graph is not mutated/frozen.
- Both adapters enforce the same exact map coordinate and byte ceilings. Native
  proximity retains its separate 250,000-coordinate and 16,000,000-GeoJSON-byte
  ceilings, plus existing query batch/deadline/cancellation limits.
- An invalid or over-capacity discovery produces no partial geometry index or
  usable distance prefix. No current GIS lookup, geometry repair, report write,
  source authorization, historical evidence promotion, or radius change occurs.
- Accepted boundary/statistics groups, assignment authorization, signing,
  database schema, and public API contracts are untouched.

## Measurement (2026-09-12)

Read-only runs against the same originally retained synthetic 38,106-account
PostgreSQL/PostGIS fixture, with a 384 MiB V8 heap limit:

| Proximity admission and binding recheck | Original | Index run 1 | Index run 2 |
| --- | ---: | ---: | ---: |
| Admission elapsed | 1,030 ms | 833 ms | 855 ms |
| Admission + binding recheck elapsed | 2,006 ms | 1,626 ms | 1,749 ms |
| Additional heap after admission | 97.6 MB | 38.0 MB | 38.6 MB |
| Process peak RSS (including graph loader) | 396,056 KiB | 347,536 KiB | 304,968 KiB |

All three produced the same canonical result SHA-256 and zero native distance
queries: this fixture still exceeds the unchanged native proximity ceiling.
These are local step measurements, not whole-page latency promises. RSS varies
with loader/garbage-collection timing. The separate real native fixture verifies
successful retained subject/four-mile distances, rights and timeout failures,
catalog read-only behavior, and atomic five-part Apply/reopen preservation.

The regression suite covers exact coordinate/GeoJSON ceilings and one-over
failures, malformed later geometry, mixed endian MultiPolygons, original retained
capture/reopen, input immutability, and parity with full-map output.

## Remaining capacity and sales work

This does not enable an over-budget five-mile or whole-city capture. Such work
must account for spatial roster bytes, source/closure limits, downstream
population processing, browser map delivery, and report publication together;
raising one guard alone is not a complete implementation.

Likewise, missing shared ClosePrice/currency/area-unit evidence is not repaired
by geometry optimization. Mapping4 preserves its original sales meaning. Old
shared imports can have discarded original headers: those values must remain
unknown until original evidence and its field meaning are retained and bound.
The existing assignment-private CSV workflow is a separate reviewed population,
not permission to silently rewrite shared sale meaning or accepted reports.
