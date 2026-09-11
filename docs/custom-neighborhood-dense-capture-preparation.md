# Dense Custom neighborhood evidence: bounded activation

New Custom captures now use the installed dense CAD factory. Existing captures
reopen from their original evidence and declared budgets; the default mapping2/3/4
reader factories remain unchanged. This is not a worker deployment, source grant,
historical eligibility change, or permission to use a partial source capture.

The activation deployment requires one 2 GB / 1 CPU web instance (or separately
validated greater capacity), retaining the one-active-operation gate described
below. The prior 512 MB deployment is not an approved dense-capture target. The
Render capacity upgrade is an operator action, not an environment-variable or
infrastructure mutation performed by this code. No autoscaling change is needed.

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
- Indexed statistics and parcel-map preparation now yield between bounded
  batches outside the database transaction. Inputs are sealed before yielding;
  cancellation never returns partial results. Exact observation cells can share
  their frozen representation within one operation, with a bounded cache keyed
  by the complete raw values and policy. Member provenance stays separate.
- Complete indexed-member byte accounting reuses checked row lengths instead
  of allocating another full JSON string. Legacy captures retain their 100,000
  record / 32 MB internal ceiling. Already owner-validated dense CAD captures
  use their original declared record limit (at most 200,000) and a 64 MB internal
  indexed ceiling. Public summary, member-page and map limits are unchanged.
- A process-wide Custom cohort HTTP gate admits one heavy operation and at most
  four waiting requests. Its 60-second deadline includes queue time. Disconnects
  and expired waiting requests leave the queue; an active permit remains held
  until its handler has finished serialization/cleanup. A full queue returns a
  private, no-store 503 with Retry-After rather than starting more heavy work.
  Ordinary routes do not enter this gate. This is not a new authorization grant,
  global rate limiter, automatic retry or cross-process lock.

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

### Full web-service and repeated-preview measurements

A subsequent private loopback harness loaded the real `oldServer.js` application
and its normal startup schema checks in the same process as native evidence work.
Only synthetic migrated test databases and the harness-owned web listener were
reachable. These measurements are not an authenticated production HTTP capture
or a live data benchmark; they were recorded before Custom activation.

- Full-service capture retained all 38,347 parcels / 38,106 accounts / 116,621
  source records. Elapsed time was 39.3 s including startup/fixture work; peak RSS
  was 379,052 KiB (about 388 MB).
- Two submitted full-size preview operations ran through the process gate with
  a measured maximum of one active heavy operation. They completed in 21.9 s
  and 20.7 s. Both included every account, all 1,030 fixture transactions, and
  38,347 mapped parcels. The complete internal indexed byte bound was 51,609,837
  bytes, not a clipped 32 MB result.
- With the loaded service, repeated-preview peak RSS was 448,152 KiB (about
  459 MB). All 306 concurrent lightweight health/readiness requests succeeded;
  observed p99 latency was 222 ms and maximum latency was 256 ms. Maximum
  event-loop delay was about 541 ms. Machine load and CPU differ from Render.
- The local full server suite passed 7,023 tests with 33 explicit skips; the
  frontend suite passed 2,318 tests. Native coordinator checks passed on a new
  loopback database. TypeScript, lint/source/bundle budgets and production build
  passed. Protected remote checks must also pass for the published commit.

This leaves too little comfortable headroom on a 512 MB web process, especially
for simultaneous photos/PDFs and a larger real-world source-size distribution.
No photo-upload/PDF concurrency or production capacity guarantee is claimed.
Do not activate a larger capture solely because a single synthetic run fits.

## Deployment acceptance and rollback

1. Confirm the approved 2 GB / 1 CPU deployment before releasing the Custom
   factory switch. The native coordinator test asserts that new captures retain
   the exact installed dense budget and that the legacy factory stays unchanged.
2. Keep the installed process-wide gate. Use a larger web instance or a separate
   bounded worker before further increases; do not revert capacity to 512 MB
   while dense captures or their retained previews remain in use.
   Multiple instances each have their own gate and total database load still
   needs a deployment-level bound.
3. Preserve the newly tested preparation/transaction split and bounded reopen
   checks; verify contention and cancellation at realistic concurrency.
4. Verify all per-statement and aggregate deadlines, late connection cleanup,
   cancellation and resource refusal without changing source membership.
5. Test the full live three-mile study, pocket preview and fresh reopen alongside
   ordinary photo/document reads on the intended capacity. Record actual counts,
   timings and resource refusals. The prior synthetic measurements do not prove
   a production source-size distribution or concurrent photo-upload/PDF capacity.
6. Coherent boundary/statistics Apply still requires all existing eligibility,
   date-support, source-rights and review gates. Do not Apply a retrospective
   current-mirror capture just to complete a capacity test.

Rollback of new dense capture activation is the single Custom coordinator factory
selection. Keep retained dense evidence support and its original limits intact so
already saved captures can still reopen. Rollback must not truncate, relabel or
delete those captures. Processing-budget failures remain explicit and atomic;
larger radii and whole-city selections are not guaranteed to fit these limits.

No historical characteristics, provider coverage, MLS rights, eligibility or
statistical validity are established by increasing processing capacity.
