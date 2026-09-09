# Cached spatial membership

`captureNeighborhoodSpatialMembership` runs the exact 4,828.032-metre PostGIS geography/spheroid polygon-distance predicate in a caller-owned, exclusive repeatable-read/read-only transaction. It preserves every intersecting parcel object ID, including multiple parcel objects sharing an account, then derives the sorted unique account roster. It does not select by residential use, sale availability, a target sale count, or parcel centroid.

The function validates the existing decimal-string point representation before SQL and checks transaction identity before and after pagination. It returns explicit incomplete results for invalid cached geometry, unresolved accounts/provenance, row/byte/time limits, or an oversized canonical roster; it never returns a truncated success. Database exceptions propagate so the owning composition can roll back and release/destroy its connection. It does not open, commit, roll back or release that connection itself.

Membership hashing binds the original point representation, exact distance semantics, and the ordered parcel records, including geometry/source hashes and sync references. The hash excludes transaction identifiers so membership from two genuine snapshots can be compared. Equality is data agreement only: it is not proof that the snapshots were shared, that the source covers every real property, or that the caller has current assignment/licensed-market authority.

Native tests mutate parcels through a separate connection: add, move and delete remain invisible to an existing repeatable-read snapshot, and become visible in a new transaction with a changed membership digest. Production capture must still perform the comparison against retained original discovery evidence in its own snapshot before context issuance. This slice does not activate a report route or that comparison.

The cache-wide invalid-geometry gate is conservative and may be expensive. Its cost must be included in end-to-end benchmarking; the earlier geography-index-only timing does not include it. Source admission and a safe indexed-query rollout remain separate requirements. No schema migration, provider request, authentication change, or citywide cohort claim is added here.

SQL semantics: [PostGIS ST_DWithin](https://postgis.net/docs/ST_DWithin.html); [PostgreSQL 17 binary hash functions](https://www.postgresql.org/docs/17/functions-binarystring.html).
