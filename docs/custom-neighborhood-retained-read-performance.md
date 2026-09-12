# Bounded retained-neighborhood reads

## Scope

Reopening a large retained Custom Appraisal study repeatedly scanned and
canonicalized the same original JSON while rebuilding its evidence graph. It
also fetched each sibling page/source payload with a separate database query.
This slice optimizes that path without changing acquisition, study membership,
statistical calculations, report eligibility, or any browser/API contract.

## Implementation and invariants

- A fresh organization-scoped blob read still checks the original text with the
  bounded JSON scanner, canonicalization, PostgreSQL representation checks,
  SHA-256 and exact UTF-8 length. Existing independent `get` behavior is unchanged.
- The repository can return a frozen, process-identity representation receipt.
  Rebuilding the same graph may reuse it only after a fresh hash and byte-length
  check of the exact primitive string. A copied/forged reference is not a receipt.
  Receipts establish neither provenance nor authorization.
- The loader retains only request-local receipt references, bounded by the
  existing distinct-blob limit. It does not cache graphs, permissions, or source
  strings across requests. The existing small-metadata text cache remains 4MB.
- Sibling references from checked directories are read sequentially in batches
  of at most eight blobs and 2MB. Parameterized SQL scopes the batch to the exact
  organization and bounds returned text against the requested byte lengths.
  Result order is checked independently from database row order. Missing,
  duplicate, unknown, corrupt, noncanonical, or mismatched results fail closed.
- Every logical reference is still charged, including duplicates/cache hits.
  Every source mapping, partition, graph edge, closure, saved selection and final
  reconstructed graph reference is checked as before. Cancellation/deadlines,
  caller-owned transactions, final material/permission fences and report-signing
  protections are unchanged. No schema, migration, environment or billing change.

## Measurements and tests

The same isolated retained synthetic study has 38,347 parcels, 38,106 accounts,
116,621 retained source records, 887 recorded groups and 421,817 map coordinates.
On Node 22 with a 384MB heap, profiled evidence-read SQL calls fell from 1,483 to
336 (92 single reads and 244 bounded batches), about 77% fewer round trips.
Total profiled reopen/catalog/map time was 23.95s before and 21.58s after; the
retained reconstruction stage was 20.93s before and 17.87s after. These are single
local measurements with profiling/GC variability, not production latency claims.
Peak RSS remained approximately 429-431MiB. No membership or map sampling was used.

Coverage includes actual receipt identity, changed bytes, later storage
corruption, sparse/duplicate/oversized batch requests, returned-row conflicts,
query failure propagation, request mutation across awaits, full original graph
parity and repeated independent reopening. Existing access-order test probes
now count every requested payload in both single and batched SQL; their denial,
revocation and one-graph-load assertions are unchanged. Native PostgreSQL checks
exercise organization isolation, byte mismatch, caller rollback and immutable
storage as well as the full retained coordinator/review/report-preparation path.

Final local validation: 7,053 server tests passed, 33 database-gated tests skipped,
zero failures; 2,334 frontend tests passed; TypeScript, lint/source budgets,
production build and bundle budget passed. The independent native coordinator's
40 check groups and native blob checks also passed against isolated PostgreSQL.
A full-web synthetic run retained the same complete counts: capture 47.99s,
reopen/catalog/map 23.18s, peak preview RSS 462,636KiB. All 346 capture and 162
preview ordinary requests succeeded; preview p99 was 158ms, maximum 169ms.
These local probes are not a production load guarantee or a controlled comparison
to earlier full-web runs that had other test processes running concurrently.

## Frozen source reuse (2026-09-12 follow-up)

The retained loader now associates each freshly read, deeply frozen source
payload with its verified representation in a private, request-local WeakMap.
The same reopen can reuse that representation during source validation and
graph-plan construction instead of canonicalizing and hashing it twice more.
No receipt is accepted from a caller, serialized, or reused across requests.
No second encoded source copy is retained. All source semantics, mapping,
partitions, routing, snapshot IDs, logical byte/blob charges and final graph
references are still checked. The public preparation and persistence APIs keep
their existing full-validation paths and identity requirements.

A fresh baseline on the same retained synthetic study took 14.64s overall and
12.26s to reconstruct the originals. Two optimized runs took 12.78s/13.16s
overall and 10.46s/10.78s for reconstruction. Each used Node 22 with a 384MB heap,
preserved all 38,347 parcels, 38,106 accounts, 887 groups and 421,817 coordinates,
and made the same 336 evidence-read queries. Peak RSS was 438,304KiB baseline
and 430,680/451,788KiB optimized; this is not a demonstrated memory reduction.
These local profiler runs indicate roughly 10-13% lower total elapsed time,
not a production latency promise or a comparison to the older hardware runs.

New regressions compare reopened sources against independent full preparation,
verify deep immutability and copied-receipt rejection, and reject a substituted
source even when its new stored blob has valid canonical bytes and a valid hash.
Final server validation passed 7,075 tests with 33 database-gated skips and no
failures. Independent native coordinator/blob and recommendation/report-Apply
checks passed using isolated databases, including final authorization fences,
lost acknowledgment recovery and coherent accepted report reopening.

## Deployment and remaining work

This is a compatible server-only forward change: no saved-data migration or new
capture is required. After protected checks, deploy the exact merged tree and
reopen the same retained study. Verify identical group/member/sale counts,
selection revision, exact map and statistics, plus ordinary report/photo reads.
Do not apply later-current CAD to a retrospective report as part of this test.

Large catalogs remain inspectable in full. The separate version-two complete
recommendation path now supports up to 1,024 named groups; this read optimization
does not change its limits or rank a clipped prefix. Historical stock evidence
is not established by a later current-CAD capture. Further speed work should
measure parsing, serialized
heavy-work scheduling and repeated whole-study loads before introducing a cache.
Any cache must preserve current source-use/assignment fences and immutable context
identity; a faster stale or partially verified answer is not acceptable.
