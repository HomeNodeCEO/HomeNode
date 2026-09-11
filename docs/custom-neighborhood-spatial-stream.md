# One-pass Custom radius acquisition

The live Custom coordinator uses a transaction-local, non-holdable PostgreSQL
cursor for radius membership. It evaluates the existing whole-parcel spheroid
predicate once and fetches at most 500 metered payloads at a time. It does not
re-run the entire distance filter and sort for every page. City polygon capture
keeps its existing keyset path. The reference reader remains available for
native differential tests.

Rows are checked against the same account, geometry, provenance, count, byte and
five-second per-query limits. One-time streamed radius acquisition has a bounded
30-second wall-clock budget (the reference/city reader remains 15 seconds),
including cold-cache reads, validation and canonical ordering. The coordinator's
existing 60-second aggregate request deadline still covers all subsequent stages.
Duplicate object IDs are a complete failure,
not silently deduplicated. Object IDs are sorted numerically before producing the
same canonical roster and evidence hash as the reference reader; scan order does
not change inclusion or the report. A complete read still establishes neither
provider completeness nor historical applicability.

The cursor closes before successful publication and is cleaned up on a failed
read. If PostgreSQL rejects cleanup after a failed statement, the existing caller
rolls back/releases the exact connection. No rows are returned as a partial result.
The Custom transaction disables JIT locally to avoid compilation overhead; global
database/session settings, aggregate request timeout and membership caps are unchanged.

Native tests compare both readers in the same repeatable-read snapshot, including
all radius versions, crossing parcels, multiple polygons for an account,
concurrent move/add/delete, malformed data, capacity refusal and portal cleanup.
Unit tests also vary scan order and page boundaries and simulate interrupted reads.

Live deployment acceptance must still time the complete capture and source-read
stages with real cache sizes. A successful spatial microbenchmark alone is not
proof that the full acquisition, historical report or appraiser review is complete.
