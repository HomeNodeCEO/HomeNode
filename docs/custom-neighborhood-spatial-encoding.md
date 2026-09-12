# Lossless compact spatial membership for new Custom captures

## Contract and compatibility

New captures use `parcel_encoding: "fixed_fields_v1"`. Each `parcels` entry
contains exactly seven literal values, in this order:

1. `object_id`
2. `account_id`
3. `source_record_hash`
4. `sync_run_id`
5. `synced_at`
6. `source_updated_at` (the only nullable value)
7. `geometry_sha256`

IDs remain strings, including values beyond JavaScript's safe-integer range.
Hashes and timestamp precision are not changed. No parcel, account, geometry,
or source field is discarded. The membership digest still hashes the original
canonical seven-field objects in the original order; the account-roster digest
also remains unchanged.

Retained originals without `parcel_encoding` keep their object representation,
page kind and original hashes. New compact originals retain the tag in their
immutable metadata and use `spatial_parcel_tuples_v1` pages. Loading selects the
matching page kind and revalidates the full original membership digest, counts,
roster, field semantics and source evidence. Unknown encodings, missing fields,
extra columns, reordered/duplicate identities and incorrect counters fail
closed. This is not an in-place rewrite or migration of accepted reports.

Consumers decode individual rows as needed. Observation grouping retains only
account/object IDs; map verification retains only its four required membership
fields. They do not allocate another complete expanded seven-field roster.
Geometry, selection, statistics and boundary/statistics Apply semantics are
unchanged. This encoding is internal retained evidence, not a changed public
HTTP request or response contract.

## Separate, explicit bounds

- `counts.bytes` keeps its old meaning: sum of canonical expanded-object UTF-8
  row sizes, excluding array punctuation.
- New `counts.encoded_bytes` is the exact compact tuple-array UTF-8 size,
  including brackets and commas, bounded at 16 MiB.
- Compact captures also have an explicit 32 MiB expanded logical-byte ceiling.
  Existing object-reader entry points retain their original 16 MiB bound.
- The 50,000-account, 100,000-parcel, per-row, query, snapshot and deadline
  limits remain in force. Every downstream source/graph/map/catalog/statistics
  and publication limit still applies independently.
- A limit hit refuses the entire capture; no prefix can replace a saved study.
  Operational diagnostics expose both numeric byte meters, never source rows.

This removes repeated field-name overhead within the existing count bounds.
It does **not** certify a particular five-mile study or unlock >50k/whole-city
support. The earlier live five-mile stop at 44,583 accounts was an incomplete
scan, not proof that its complete roster is below 50,000.

## Measurements and acceptance

Read-only local PostgreSQL/PostGIS synthetic city with an interior hole:
35,606 accounts and 35,847 parcels, same snapshot membership and canonical row
hashes. Object metadata was 12,248,568 bytes; tuple-array metadata was 8,341,246
bytes (31.9% smaller). One observed acquisition run was 681 ms for object
streaming versus 888 ms compact, with peak process RSS 99,256 versus 103,088 KiB.
These are local acquisition-stage measurements, not whole-page production
latency or reduced peak-memory claims. Strict encoding/decoding costs CPU.

A separate generated 50,000-account cursor fixture contains realistic
17-digit account IDs, large object IDs, two hashes, a UUID and two microsecond
timestamps per row. Its 19,150,000 expanded bytes exceed the unchanged legacy
16 MiB bound; all 50,000 members fit in 13,700,001 encoded bytes with identical
independently calculated row, roster and membership hashes. The same fixture
with 50,001 accounts is wholly refused by the unchanged account ceiling. No
limit overrides are used. This proves the capture representation only, not
real-world source completeness or end-to-end 50k map/report capacity.

Tests cover every installed radius and dated city polygons, native PostGIS
holes/islands/crossings/touches, arbitrary cursor order, exact byte limits,
one-over refusal, transaction changes and portal cleanup. Retention tests cover
prepare/persist/reopen, immutable legacy references, exact encoded/expanded
counts, unchanged map/index/preview/catalog/proximity results, source hashes,
hostile object shapes and encoding/count/order tampering. No production source
rows are rewritten as part of this release.
