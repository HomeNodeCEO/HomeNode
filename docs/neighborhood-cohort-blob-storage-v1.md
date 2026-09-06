# Retained neighborhood evidence blobs

This is the first storage slice of the accepted context/capture design `c74d9b49b9acd0fc6a7944a534ff4b458a7257706b222ae9795d43a82e69e68c`, implemented for the Custom Appraisal integration. It is not a live acquisition coordinator or source-fact issuer.

## Installed choices

- A new application migration creates only `app.neighborhood_cohort_evidence_blobs`, keyed by organization and SHA-256. Existing migrations and parent tables are unchanged. Register through the existing application/mobile runner, not request-time DDL.
- Store exact canonical UTF-8 text and byte count. No duplicate JSONB projection is needed yet. The existing JSONB compatibility guard still enforces the independent 2 MB storage limit; PostgreSQL checks JSON validity and that storage limit too.
- Reuse the original-token scanner, `canonicalAssessmentJson`, and `assertNeighborhoodJsonbStorage`. The input must already be canonical; noncanonical input is rejected, not silently reserialized. Limits remain 1.5 MB UTF-8, 100,000 nodes, and depth 35.
- References remain `{ content_sha256, canonical_utf8_bytes }`, with the byte count as canonical integer text. The repository's `get(hash, bytes)` takes primitive reference components, verifies the actual stored bytes again, and returns the exact canonical text or `null` for a missing organization-scoped record.
- Repeated writes deduplicate only within the bound organization after exact content, length and digest comparison. A mismatch fails; it never overwrites. No cross-organization lookup or deduplication endpoint exists.
- Statement-level guards reject ordinary UPDATE, DELETE and TRUNCATE, including direct SQL. The migration owner can manage schema changes; these guards do not claim to constrain a database administrator.
- `stored_at` is storage time only, never source-capture time or historical-availability evidence.

## Ownership and remaining integration

The caller supplies its owned transaction client and one already-authorized organization. The repository never acquires a pool client, starts/commits a transaction, retries failures, promotes current context, mints permissions, or marks facts eligible. Database errors propagate to that owner for rollback, deadline handling and safe external error translation. Do not mount this repository as a generic blob API.

Context/target references must provide exact assignment scope and fresh read permission. Those context, acquisition, capture, study, intent and current-head stores are not implemented by this slice. Original private dispatch/read/completion provenance remains necessary; a copied JSON/hash/blob reference is not that provenance. Operation-wide budgets and deadlines must be supplied by the genuine coordinator before activation. The limits above are component limits, not a whole-operation timing guarantee.

No provider data is downloaded, production table is backfilled, or report calculation changes here. Before broad activation, finish scoped references and rollback/replay tests, account for aggregate context storage limits, and define authorized retention/cleanup. Immutable evidence cannot be routinely deleted by the report runtime.

## Verification boundaries

Unit tests use a fake SQL client and verify mapping, scope parameters, limits, mismatch refusal, and transaction ownership. Real PostgreSQL assertions run inside the existing isolated CI child-database suite, with ordinary migrations, to verify exact UTF-8 round trips, tenant keys, mutation guards, rollback, concurrent idempotent inserts, and deliberately corrupted-reference refusal. The local no-database suite skips that real-PG test; do not report a skipped test as a pass or this component as an end-to-end Custom save/reopen feature.
