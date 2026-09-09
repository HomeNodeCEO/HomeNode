# Caller-owned cached source snapshot

`createNeighborhoodCachedSourceReader(pool, {access, limits}).captureInSnapshot(client, issuedInput, {signal, deadline})`
reuses the exact existing source-query and capture implementation without owning
the checked-out client's transaction. Ordinary `capture(issuedInput)` keeps its
existing connection, transaction, cleanup, result and evidence behavior.

The caller must exclusively own an explicit PostgreSQL `REPEATABLE READ READ ONLY`
transaction. Before calling, set transaction-local UTC and finite positive
timeouts: `statement_timeout` no greater than the reader's `statement_ms` limit,
`lock_timeout` no greater than 1,000 ms, and
`idle_in_transaction_session_timeout` no greater than 10,000 ms. Lower caller
timeouts are preserved. The new API only reads these settings; it never sets
them, connects, begins, commits, rolls back, releases, or destroys the client.

The reader checks PostgreSQL's actual isolation/read-only settings, backend PID,
MVCC snapshot, and microsecond transaction start twice before source reads and
again after them. It requires transaction start to precede the probe statement,
so autocommit is rejected even with repeatable-read/read-only session defaults.
Changing transaction/snapshot identity discards all captured source bytes.

Successful caller-owned results add frozen `snapshot` comparison metadata
(`backend_pid`, `snapshot`, `transaction_started_at`). Source captures and query
evidence retain their existing formats. This metadata is not a transferable
capability or proof of spatial membership, original acquisition, provider
coverage, factual support, or current authorization.

The original one-use server-issued selection and licensed-market capabilities
are mandatory before any reader SQL. The complete one-hop transaction closure,
source chronology, paging, size limits and unavailable-source guards are shared
with ordinary capture. No eligibility flag or historical capability changes.

`deadline` is an optional absolute `performance.now()` timestamp shared with the
owner's larger operation; it can shorten but never extend this reader's duration
limit. `signal` is an optional `AbortSignal`. Cancellation and deadlines are
checked before/after awaited bounded queries and during final capture creation.
Cancellation does not race away from an active driver query; its current query
must return or hit its timeout. Following SQL errors/timeouts, the owner must
roll back or discard the client before reuse. The caller transaction remains
open during bounded hashing/chunking, unlike ordinary capture.

The intended composition is: begin/configure the owner snapshot, read actual
spatial membership, resolve the trusted selection and identity closure for that
membership, prepare fresh read capabilities, then capture source rows on the
same client. Compare the returned snapshot with the original membership capture
and reject any drift. Every intermediate reader must use that same exclusive
transaction; copied JSON/hashes cannot substitute for original reads. Authorize
the spatial read independently, before discovery. This change does not install
the spatial producer, context issuer, source admission, Custom mapper or routes.

Focused unit tests are in `server/test/neighborhoodCachedSourceReaderSnapshot.test.js`.
The separate native test is opt-in through `NODE_ENV=test` and
`NEIGHBORHOOD_SNAPSHOT_DATABASE_URL`, restricted to a fresh loopback database named
`neighborhood_snapshot_<32 lowercase hex characters>_test`. It refuses existing
app/core/gis schemas and uses minimal synthetic projection fixtures, not a
production dataset or canonical-migration certification. It verifies autocommit
and wrong-mode refusal, a real second-client commit between metric discovery and
source capture, fresh-snapshot visibility, owner work preservation and actual
server timeout cleanup responsibility. Ordinary runs skip this native test
without the explicit dedicated URL; no GitHub Actions environment is spoofed.
