# Custom neighborhood capture diagnostics

A refused capture does not establish missing sales. Separate known capacity
ceilings (422 `neighborhood_capture_capacity_exceeded`) from interruption/time
limits (503 `neighborhood_request_interrupted`) and missing/unverifiable sources
(existing 422 `neighborhood_source_unavailable`). Mixed or unrecognized failures
remain unavailable. No response contains a source row or internal error detail.

The capture route logs only an enumerated stage, category, checks and whitelisted
nonnegative integer counters. It never logs the request, principal, account ID,
source filename, raw error, SQL, policy text or credentials. A failed log sink
cannot change the response or saved-operation recovery. Logs are operational
diagnostics, not evidence, authorization, or a successful capture receipt.

Reload saved choices and resume the exact operation after a transient failure.
A size limit needs a capacity implementation change; repeated identical captures
will not resolve it. Setting aside the pending operation preserves accepted
report data. No automatic retry, smaller radius, partial roster, Apply or signing
is introduced here. Existing limits and all source admission checks stay intact.

Capture-phase logs retain the aggregate `source` wall time and additionally emit
fixed `source_authorization` and `source_read` spans. The first includes existing
policy and transaction-closure discovery; the second includes source SQL, row
mapping and finalization, and incomplete-result classification. The spans nest
inside `source`, so do not add them to the outer duration. They contain only
fixed phase/outcome labels and numeric durations/elapsed times, never individual
records or authorization inputs. A throwing logger cannot change capture results.

Dense readers also emit one bounded `source-read-timing` event per invocation,
with aggregate query counts/wall time for a fixed tag list, total duration,
non-query wall time and post-query finalization time. Unknown internal tags are
counted only as `other`, never echoed. Timed queries cover the existing reader
query wrapper, not the preceding owner's `access.prepare` or a separate direct
cleanup call. No parameters, identifiers, row data or error strings are logged.
`completed` means the method returned normally, not that its result established
complete or eligible evidence. A zero finalization value can mean that the
checkpoint was not reached or the measured duration rounded below one ms.
Non-query time includes CPU, GC and cooperative scheduling; it is not a CPU meter.

## Remaining capacity work

Live dense-suburban testing exposed a mismatch between a 50,000-account spatial
roster and the source reader's 100,000-total-record / 30 MB budget. Selection,
parcels, accounts, transaction identities and sales each consume that total.
A 1,000-row CAD sample measured about 1.94 MB of mapped parcel evidence; this is
an estimate, not a completed three-mile source capture. Raising a timeout alone
cannot fix the record/byte ceilings. Do not silently cap the study to 30 sales.

Before increasing supported capacity, measure a complete dense-area capture,
deduplicate retained representations without changing hashes/evidence semantics,
bound memory in the web process (or move acquisition into a durable worker), and
exercise full capture -> preview -> pocket edits -> coherent Apply -> reopen.
Current CAD remains current reference when historical stock evidence is absent.
