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
