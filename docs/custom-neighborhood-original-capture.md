# Original Custom cache acquisition handoff

`consumeNeighborhoodCachedAcquisition(reader, result)` is an internal,
one-use provenance handoff for the future acquisition-retention composition.
Only the exact successful result object from that exact reader is admitted.
Copies, serialized results, matching hashes, incomplete results and replay do
not recreate an original invocation. A wrong-reader attempt does not consume
the genuine result.

The private handoff preserves the actually consumed immutable query request,
including the complete transaction identity closure, the exact compact JSON
used before hashing the selected-account stream, and the original final capture.
It does not read mutable cache rows again or reconstruct missing provenance
from public closure counts. Weak keys allow abandoned captures to be collected.
Public result fields, hashes and serialized output are unchanged. No additional
SQL, route, provider call, migration, or report write is introduced.

Both `capture()` and `captureInSnapshot(client, input)` can furnish this original
handoff. The former registers only after its own successful COMMIT and release;
the latter registers after its final snapshot check and bounded evidence build,
without ending, changing or releasing the caller's transaction. Its snapshot
descriptor is comparison metadata, not a transferable authority capability.
Consumption performs no SQL and does not certify the caller's later COMMIT.

The snapshot owner must keep membership, trusted selection, licensed transaction
identity closure and source capture on the same exclusive, explicit REPEATABLE
READ READ ONLY client. Trusted callbacks must use that client, not independently
query the pool. Original source capture alone does not certify original subject,
membership or selection acquisition. Required subject capture/freshness checks
and separately authorized retention writes retain their own write-transaction
contracts; never write retention records in the read-only snapshot transaction.
Only the retention owner may report durable success after its own COMMIT. A read
rollback or failed write/COMMIT does not invalidate the fact of the prior read,
restore a consumed handle, or establish persistence of any evidence.

This establishes local query origin only. It is not fresh assignment access,
an MLS license, provider coverage, source admission, a historical completeness
claim, a current-head decision, or authority to apply or sign a report.
Before retention, the caller must establish fresh exact Custom assignment and
licensed-data authorization, original context/selection binding and bounded
transaction ownership. Do not expose the handoff as a browser API, serialize
its private transaction identities into ordinary responses, or treat retained
JSON as a replacement for the original runtime handoff.

Consume only when beginning the authorized retention attempt. A failed attempt
does not restore a consumed runtime handle; obtain a new authorized capture or
use a separately established immutable idempotent replay path. This change
does not implement that retention transaction or the final live setup/Apply
workflow. Boundary, population and statistics must still apply together.
