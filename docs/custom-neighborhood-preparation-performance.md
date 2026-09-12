# Custom capture preparation: reuse within one sealed operation

## Observation

A live current-date QA capture completed source acquisition but exhausted the
existing operation budget during evidence preparation. No report group applied.
A local CPU profile of the dense synthetic fixture identified repeated canonical
encoding and representation scanning as substantial costs.

Source validation already prepares and checks every source payload's blob
representation. Batched preparation now retains that identity-bound reference in
a private WeakMap for the later blob-planning step in the same operation.

## Invariants

- The complete input graph is frozen before the first asynchronous yield.
- Source identity, mappings, upstream digest, closure, routing, scope, chronology,
  and completeness validation still run. A representation receipt is not source
  provenance, current authorization, eligibility, or permission to Apply.
- All logical byte/blob/reference charges remain identical, including duplicates.
- Synchronous callers still retain detached canonical text.
- No global cache, encoded study copy, transferable receipt, schema change,
  query/membership change, timeout increase, or signed-report change is introduced.
- Cancellation and any validation failure publish no prepared result. Persistence
  still rechecks original references, exact bytes and database acknowledgments;
  the owning transaction still rechecks authorization and subject freshness.

## Measurements and verification

Node 22.23.2, same opt-in synthetic fixture: 38,106 accounts, 38,347 parcels,
114,563 source records. Profiled preparation decreased from 13,634.9 ms to
9,426.5 ms (30.9%); full capture/preparation/persist/reopen decreased from
32,012.6 ms to 27,821.4 ms (13.1%). Both retained exactly 1,456 blobs, 1,505
references, and 301,000,138 logical bytes. This is local evidence, not a promise
of equivalent production latency.

Full server suite: 7,080 passed, 34 database-gated skipped, zero failures.
Separately, native PostgreSQL capture and a fresh-process preview passed with
38,106 accounts, 38,347 parcels, 1,030 transactions and 887 recorded groups.
The bounded 384 MiB-heap full-web fixture retained complete geometry and served
all 480 concurrent loopback health requests successfully. No production database
connection or report Apply was used by these tests.

Remaining work includes live capture/Apply/save/reopen validation, source-read
latency and overlapping legacy automatic analysis. Historical source coverage
remains a separate eligibility requirement.
