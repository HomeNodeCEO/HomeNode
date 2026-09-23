# Custom Appraisal signed-PDF parity audit

Before moving signed PDF bytes out of PostgreSQL or changing the missing-PDF
fallback, run `npm run audit:custom-signed-artifacts` from `server` against a
staging database restore, then against each intended environment during an
approved read-only audit window. The command uses `DATABASE_URL` from that
environment. Use an internal database connection or a TLS connection with
certificate verification; the audit does not disable TLS verification. It
never writes application rows or attempts a repair.

The audit uses a read-only transaction, a five-second statement timeout and a
one-second lock timeout. Its output contains only aggregate counts: signed
snapshots, linked artifacts, missing artifacts, wrong snapshot links and
snapshot/PDF checksum-link mismatches. Missing tables are reported as a stable
schema code. Database errors are reduced to a stable code; no file IDs,
reports, PDF bytes, connection strings or raw database diagnostics are printed.

A nonzero exit indicates gaps or an incomplete audit, not permission to
regenerate or delete a signed PDF. Review legacy signed files and migration
state before changing their read path. Historical signature events and PDFs
must remain immutable and separately addressable when the future revision
workflow is introduced.
