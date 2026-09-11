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

### Dense-radius cursor plan follow-up

The first live activation attempt stopped in spatial membership (not the source
byte budget) after 30.8 seconds, at 29,000 parcels. An isolated read-only probe
at the saved subject point reproduced the same limit: 30.4 seconds were spent
in database FETCH calls, with about 0.3 seconds elsewhere. PostgreSQL chose a
plain Index Scan of the existing geography index. Changing only the cursor's
planner preference selected a Bitmap Heap Scan using that same index and
completed all 38,337 parcels / 38,096 accounts in 10.6 seconds. A separate probe
restoring the caller setting immediately after DECLARE still completed the
same counts in 14.1 seconds. These are individual live read-only measurements,
not throughput guarantees; the earlier synthetic/parcel-point counts differ
from this saved subject point and must not be substituted for it.

The radius streamer now saves `enable_indexscan`, uses transaction-local `off`
only while declaring its cursor, and restores the exact prior value before
FETCH. Bitmap index access remains available. Keyset/city readers, other source
queries, pool/session settings, predicates, deadlines, counts and evidence hashes
are unchanged. If SQL fails, the existing caller-owned rollback resets LOCAL
settings; the original database error remains authoritative. Native differential
tests verify identical complete membership and restoration of both on/off states.
This narrow measured workaround follows PostgreSQL's distinction between plain
and bitmap scan planning; see [query-planning options](https://www.postgresql.org/docs/current/runtime-config-query.html).

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

### Aggregate deadline after spatial-plan correction

The first live resumed Hardy capture passed spatial discovery but exhausted the
old coordinator deadline at 59.018 seconds (60 seconds minus cleanup reserve).
Its source reader had counted 111,535 records / 103,974,724 bytes across 335
queries. A query-owner rejection masked that deadline as source unavailability;
the reader now classifies its own expired clock or cancellation signal when SQL
rejects, without exposing driver details or trusting arbitrary error text.

Only initial capture gets a 120-second aggregate server budget, including gate
queue time and the existing cleanup reserve. Earlier caller deadlines still win.
The browser capture request has 125 seconds of bounded transport grace. Saves,
catalogs, previews and other requests keep their existing budgets. Source reads
still have their independent 60-second/128 MB/200k-record ceiling, SQL statements
remain at five seconds, and one heavy operation/four queued operations remain
the process-wide limit. A deadline never authorizes partial persistence or an
automatic retry: explicit recovery keeps the saved operation UUID. These bounds
enable measured larger captures; they do not promise instant initial acquisition.

### Bounded immutable retention

On the 2 GB/1 CPU service, the resumed three-mile capture reached its final
immutable evidence retention but exhausted the 119-second effective deadline.
A read-only database-activity observer confirmed spatial discovery, source
acquisition and preparation had finished before the blob inserts. No partially
registered context or report Apply was accepted. This is not a successful live
large-study acceptance result.

Retention now reuses the original in-process representation-validation receipt,
rechecking exact UTF-8 length and SHA-256 against each immutable string. Receipts
are frozen object identities in a WeakSet, not serialized authority or source
provenance. Copied or forged references fail before SQL. Batches contain at most
eight blobs and 2 MB of encoded text, never an extra encoded copy of the entire
study. Each parameterized insert and conflict read remains organization-scoped;
every returned hash, byte count and exact string must match, independent of row
order. Missing, duplicate, unknown or corrupt acknowledgments fail the caller's
transaction. Independent reads still fully scan, parse and validate the bytes.
All original access, freshness, complete-membership and commit checks remain.

A local representation-only benchmark over 91,350,750 synthetic bytes reduced
duplicate validation from 2,192 ms to 75 ms using prepared receipts; this excludes
real SQL and is not an end-to-end production speed claim. Native full-web tests
retained/reopened all 38,347 synthetic parcels and 38,106 accounts, with a complete
1,030-transaction preview. Capture/prepare/retention completed in 42.3 seconds
and the preview in 32.9 seconds; peak RSS was about 356/412 MiB. Concurrent
ordinary health/readiness requests had zero failures. These runs were not an
uncontended before/after throughput comparison. The unchanged live deadline,
resource guards, existing operation UUID recovery and fresh-reopen acceptance
must still be verified against the real source distribution after deployment.

No historical characteristics, provider coverage, MLS rights, eligibility or
statistical validity are established by increasing processing capacity.

### Live phase observability

The first PR730 live retry still exhausted the effective 119-second aggregate
deadline. To isolate the remaining real-data cost, captures emit six fixed
operational phase timings: subject, spatial, source, preparation, retention and
registration. Each event contains only phase/outcome and integer elapsed times;
no identifiers, errors, SQL, source records or request payloads are logged. A
phase can emit once per capture, and logger failures cannot alter recovery.
Registration timing is not itself proof of COMMIT or accepted report Apply.

When an in-flight driver query rejects at the owner's aggregate deadline, the
owner checks its own clock/signal before reporting the failure. The actual driver
error still causes connection discard. Existing unknown-COMMIT handling has
priority; this does not permit a blind retry or suppress an earlier SQL failure.
Ordinary query limits, access checks and accepted-report behavior are unchanged.

### Complete dense parcel display

The instrumented production capture subsequently committed successfully in
112.984 seconds: 38,337 parcels, 38,096 accounts and 1,601 in-period transaction
observations. Its saved catalog reopened in 49.876 seconds. Initial acquisition
is therefore working on the approved capacity, but is not instant and remains
close to the aggregate deadline. This is not full neighborhood/report acceptance.

A read-only audit of that exact retained context measured 411,659 coordinates,
7,583,936 EWKB bytes and 17,714,334 GeoJSON bytes. The previous 250k-coordinate /
16MB-GeoJSON display ceiling refused the whole map correctly; no captured rows
were missing. Parcel display now admits up to 500k coordinates and 24MB GeoJSON.
The independent 16MB total EWKB, 1MB per geometry, 100k parcel and 50k account
guards are unchanged. Every original ring, hole, part, identifier and hash is
preserved; no simplification, sample, fallback circle or partial map is returned.

Browser geometry admission and label traversal match the new coordinate limit.
Only the map-preview transport allows a 27MB response envelope (24MB geometry,
the unchanged 2MB summary and framing). Other transport and request limits stay
unchanged. Geometry is reused on selection-only changes, and map and statistics
still advance as one checked revision. Tests exercise an actual producer through
transport and controller with 450k coordinates, unchanged geometry after edits,
and complete refusal above the independently enforced byte/coordinate bounds.
The native full-web memory fixture now uses ten-edge polygons (421,817 vertices)
instead of tiny five-point rectangles to reflect real dense map payloads.
It completed capture in 61.7 seconds and reopen/preview in 41.3 seconds with all
38,347 parcels, 38,106 accounts and 1,030 transactions. The resulting map was
23.5MB, with peak RSS about 451 MiB. Concurrent ordinary web probes had zero
failures (408 during capture, 248 during preview). Other local suites were also
running, so these are bounded synthetic acceptance measurements, not a direct
throughput comparison. Native proximity recommendation work retains its prior
250k-coordinate/16MB guard independently from the larger display budget.

The map-only slice was deployed and the same retained live study reopened with
all 38,096 accounts and 1,601 in-period transactions, without another acquisition.
Its map and statistics advanced together. The later-current-CAD historical-stock
warning remains; no accepted report was changed by this display verification.

### Versioned dense recorded-name catalog

The workspace now requests catalog v2, admitting up to 1,024 recorded-name
groups. Pure legacy consumers still default to v1/128. Both keep the original
50k account, 100k CAD source-record, 4,096 raw-variant and public-response byte
guards. An over-limit catalog remains the WHOLE unresolved roster, never a
clipped prefix. Names are county/recorded-label groups, not verified legal
subdivision, HOA, phase, builder or competitive-market identities.

Checkpoint v5 supports 1,024 named IDs plus unresolved within 128 KiB, including
the matching section-save/ACK transport. Versions 1–4 retain their exact former
grammar and 32 KiB/128-name limits. The existing 850k workfile-section ceiling,
authorization, signing locks, CAS and source-use policy are unchanged.

An old dense catalog represented every account as `discovery:unassigned`.
Before showing a v2 selection, the browser upgrades that old single included
group to all new groups (or preserves an explicitly empty selection). It saves
v5 and a new selection revision using the existing section CAS, then verifies
the exact target, revision and value acknowledgement. Unknown legacy named IDs,
changed contexts or uncertain acknowledgements fail closed and require a fresh
reload; no partial migration or replacement capture occurs. New captures save
v5 once a v2 catalog has been checked. A pending capture never discards the old
active checkpoint. No accepted report values are migrated.

Report/preparation owners derive the catalog version from the validated saved
checkpoint, not request input. V2 member resolution uses the same public catalog
projection the appraiser saw, including response-byte fallback semantics. The
selection is always one exact account union, avoiding redundant per-group
statistics and preserving all selected members. Legacy report replay remains
on v1. Existing temporal, source, geography, revision and permission fences stay
in place. Deploy the compatible server and frontend together. After v5 saves
exist, do not roll back to a pre-v5 reader or erase saved checkpoints; use a
compatible forward fix or an explicitly reviewed data-preserving migration.

The group list renders 50 rows per page and searches the entire catalog. Map
click inspection works for off-page groups. Labels can cover all 1,024 groups
within a separate 2MB output budget, using actual retained exterior vertices;
they do not infer subdivision perimeters. Pagination never filters map or
statistical membership. Full-catalog automatic ranking remains capped at its
previous 128 groups and is explicitly unavailable for larger catalogs; neither
a top128 sample nor extra native proximity work is substituted.

Validation includes 887/1,024/1,025-group catalogs, legacy fallback and explicit
empty selection migration, lost/wrong save ACKs, repeated reopen, v5 transport,
1,024 long map labels, paginated component interaction and real retained 887-group
report/preparation result parity. A synthetic full-web run with 38,347 parcels,
38,106 accounts, 887 groups and 421,817 vertices completed capture in 53.5 seconds
and reopen/catalog/map in 39.1 seconds. Catalog output was 966,497 bytes; peak preview
RSS was 456,652 KiB. All 378 capture/236 preview ordinary probes succeeded; preview
p99 was 658 ms and maximum 1.39 seconds while other local tests ran. These are local
bounded-work measurements, not a production latency guarantee.
