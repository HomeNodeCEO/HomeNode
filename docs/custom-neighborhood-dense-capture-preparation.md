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

## Required before activation

1. Measure complete dense native capture, durable retention and a separate fresh
   reopen on realistic CAD wrapper sizes, including event-loop lag and peak RSS.
2. Reduce peak retained copies or isolate heavy processing in a bounded worker.
   Bound concurrent captures independently of ordinary web requests.
3. Keep CPU preparation from holding database locks/idle transactions beyond
   their timeout. Move pure work outside lock-holding registration where possible,
   then retain the existing final subject, policy and assignment freshness fences.
   Yielding the event loop alone does not keep a PostgreSQL transaction alive.
4. Verify all per-statement and aggregate deadlines, late connection cleanup,
   cancellation and resource refusal without changing source membership.
5. Wire the dense mode only after those checks, then test the full live three-mile
   study, pocket preview, coherent boundary/statistics Apply and fresh reopen.

No historical characteristics, provider coverage, MLS rights, eligibility or
statistical validity are established by increasing processing capacity.
