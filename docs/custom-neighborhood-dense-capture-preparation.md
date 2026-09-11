# Dense Custom neighborhood evidence: preparation, not activation

This slice prepares a larger loader. It does **not** enable it in the Custom
capture coordinator, change the default mapping2/3/4 readers, deploy a worker,
increase a Render plan, or make a partial source capture usable.

## Changes

- A separate dense CAD factory partitions the already authorized roster into
  1,000-account query batches. Each batch exhausts its existing 250-row keyset
  in the same caller-owned repeatable-read snapshot. All selected accounts,
  parcels, transaction identities, sale links and source observations remain.
- Immutable source data can be shared by the emitted chunks, avoiding a second
  parsed copy of every CAD wrapper. The default builder still detaches inputs
  and emits the same canonical chunks/hashes for successful inputs.
- Bounded work batches yield between source hashing, chunk construction, and
  retained-graph validation. Abort/deadline checks surround asynchronous yields;
  no partial capture or preparation is returned. Preparation seals its internal
  original input before yielding, preventing mutation between validation steps.
- Batched preparation retains immutable values and encodes one blob at a time
  for persistence. Reopen caches at most 4 MB of small metadata, rather than every
  full source payload, and does not recompute a source hash already validated in
  the same sealed graph. Complete per-blob, mapping and graph checks remain.
- New capture preparation runs after the read connection is released and before
  final registration locks. Registration still checks current assignment,
  subject, market rights and private-CSV review. Native coverage verifies that
  asynchronous preparation has zero checked-out connections.
- Reopen validates within its caller-owned read transaction, with periodic
  identity checks through that same bounded client during CPU work. The Custom
  transaction owner also handles checked-out socket errors and discards failed
  clients instead of letting an unhandled event terminate the web process.
- Dense budgets are installed code, not browser parameters or source grants.
  Per-row SQL transport, per-blob validation, scoped source capabilities and
  original-only handoffs remain required. Retained evidence retains its original
  declared limits and mapping version.
- Retained graph accounting admits 200,000 source records and 512 MB of logical
  reference charges. Logical charges are **not** physical memory usage. Original
  graph hashes and the repository's exact-scope/original-preparation checks stay
  unchanged.

## Evidence and limitations

Normal tests cover exact default/batched construction parity, cancellation,
immutable inputs, 2,101-account query partitions, metadata budget rejection,
complete persistence/reopen, and no authority upgrade. The native PostgreSQL
suite also compares both CAD factories' six source record sets and runs the
existing capture/reopen, scope, concurrent-edit, revocation, lost-acknowledgment,
private-CSV and retrospective refusal checks.

An opt-in synthetic query/storage-fake measurement is available:

```
HOMENODE_DENSE_CAPTURE_BENCHMARK=1 node --test \
  --test-name-pattern="dense evidence capacity measurement" \
  test/customCohortCaptureInputs.test.js
```

One local run retained 38,347 parcels, 38,106 accounts and 114,563 source records.
It charged 301,000,138 logical bytes across 1,456 blobs. Capture took about 7.3 s,
preparation 16.3 s, and complete fake persistence/reopen 56.1 s. Peak process RSS
was 780,552 KiB. These are **synthetic** timings, not production throughput or a
native dense-area memory guarantee; the fake store and original input coexist
with reopened data, unlike independent production requests.

Nevertheless, this does not establish safe operation on a 512 MB web instance.
Do not activate the larger factory merely because these tests pass.

### Follow-up optimization measurements

After removing retained text copies, the same fake-store workload measured
45.8 s and 703,720 KiB peak RSS: about 18% less elapsed time and 10% less peak RSS.
It retained the same counts and evidence graph. This comparison precedes the
additional page-level yield and connection-check changes.

The separate opt-in native helper `neighborhoodDenseCaptureMemoryChecks.js`
uses a new migrated loopback test database and independent capture/reopen
processes. A successful run with a 384 MiB V8 old-space ceiling retained all
38,347 parcels and 38,106 accounts, including 116,621 source records. The source
reader accounted for 101,902,518 bytes. Native capture/preparation/persistence
completed in 37.2 s at 315,148 KiB peak RSS; fresh reopen completed in 19.1 s at
341,352 KiB. Maximum event-loop delays were 368 ms and 196 ms respectively.

These are synthetic CAD/MLS records, not live data or production CPU performance.
An earlier fixture with deliberately longer repeated CAD descriptions correctly
hit the source byte ceiling. An earlier fresh-reopen run exposed the idle
transaction timeout; the bounded identity-check fix made the subsequent run pass.
No resource ceiling or membership was relaxed to hide either failure.

An isolated process fitting does not prove enough remaining memory for the full
web server, simultaneous requests, map/statistics generation or city-wide studies.

## Required before activation

1. Extend the native measurements to the complete loaded web service and actual
   source-size distribution, including maps/statistics and concurrent requests.
2. Bound concurrent heavy requests independently of ordinary web requests. Use
   a separate bounded worker if measured web-server headroom is insufficient.
3. Preserve the newly tested preparation/transaction split and bounded reopen
   checks; verify contention and cancellation at realistic concurrency.
4. Verify all per-statement and aggregate deadlines, late connection cleanup,
   cancellation and resource refusal without changing source membership.
5. Wire the dense mode only after those checks, then test the full live three-mile
   study, pocket preview, coherent boundary/statistics Apply and fresh reopen.

No historical characteristics, provider coverage, MLS rights, eligibility or
statistical validity are established by increasing processing capacity.
