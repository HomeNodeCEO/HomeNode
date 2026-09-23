# Custom Appraisal signed-PDF parity audit

Before moving signed PDF bytes out of PostgreSQL or changing the missing-PDF
fallback, run `npm run audit:custom-signed-artifacts` from `server` against a
staging database restore, then against each intended environment during an
approved read-only audit window. The command uses `DATABASE_URL` from that
environment. Use an internal database connection or a TLS connection with
certificate verification; the audit does not disable TLS verification. It
never writes application rows or attempts a repair.

The audit uses a read-only transaction, a five-second statement timeout and a
one-second lock timeout, with bounded connection and client-side query waits.
Its output contains only aggregate counts: signed
snapshots, linked artifacts, missing artifacts, wrong snapshot links and
artifacts whose recorded workfile checksum differs from the signed snapshot
checksum. The audit does not read or hash stored PDF bytes; verify byte
integrity separately before moving them. Missing tables are reported as a stable
schema code. Database errors are reduced to a stable code; no file IDs,
reports, PDF bytes, connection strings or raw database diagnostics are printed.
Counts are printed only after the pool closes cleanly. Connection, audit,
rollback, idle-pool and shutdown failures never print partial results.

The separate `npm run audit:custom-signed-pdf-content` command checks the
stored PDF bytes themselves. PostgreSQL computes SHA-256 on each `content`
value and compares it with `content_sha256`, checks that the first five bytes
are `%PDF-`, and compares the stored byte length with `byte_size`. Only four
aggregate counts leave the database; neither the report bytes nor assignment
identifiers are selected or logged. This is an opt-in, read-only full scan of
the PDF artifact table and can consume database I/O and CPU. Run it off-peak
on a staging restore first, then in each intended environment during an
approved audit window. The statement is capped at ten seconds and returns a
stable failure code rather than partial counts if it times out. A zero
artifact count is not evidence that signed files have PDFs: run the parity
audit above too. A matching digest/header does not prove that the PDF renders
or that a future R2 copy has the same bytes. The digest and bytes currently
reside in the same database, so this check is not independent proof against a
database actor able to rewrite both.

The Render Free staging web service does not expose Shell or one-off jobs.
Use a separately approved read-only execution environment with an appropriate
TLS connection; do not copy or print database credentials into this report.

A nonzero exit indicates gaps or an incomplete audit, not permission to
regenerate or delete a signed PDF. Review legacy signed files and migration
state before changing their read path. Historical signature events and PDFs
must remain immutable and separately addressable when the future revision
workflow is introduced.
