# Neighborhood revision contract projection

Each child-row guard previously read the complete parent assessment JSONB just
to inspect its contract version. A stored generated JSONB column now holds that
same expression, `assessment->'contract_version'`, so the guard can read the
small value directly. It is not a caller-written cache or a substitute for the
original assessment, evidence hashes, publication validation or authorization.

The new migration preserves both released migration files. Child identity,
source scope, contract/member-unit checks and `FOR SHARE` locks remain unchanged.
The revision publication guard still compares every original immutable column;
it excludes only the new generated column because BEFORE triggers run before
PostgreSQL computes its new value. Direct generated-value writes are rejected by
PostgreSQL. JSONB numeric/type/null semantics are preserved without text coercion.

## Rollout

Adding a stored generated column can rewrite the table and requires an exclusive
table lock. Inspect revision counts, table size and active locks before deployment.
The migration sets transaction-local limits in a separate statement before DDL:
at most one second for lock acquisition and 30 seconds per statement, retaining
any stricter existing nonzero limit. The normal runner commits the column and
guard changes together or rolls them all back. It does not retry or bypass locks.
Local settings end with the enclosing transaction.

An existing column is accepted only when its type, generated/storage metadata
and exact expression match the intended projection. A mismatch fails closed.
Do not manually drop the column in production or edit already-recorded migration
checksums. A future rollback must keep the generated-column-aware revision guard
while this column exists; restoring the older whole-row comparison alone would
incorrectly reject publication updates.

## Verification

Structural tests reverse only the intended substitutions and compare both guard
bodies to the released definitions. Native tests cover populated-table upgrade,
canonical data preservation, both contract versions, immutable rows, generated
writes, repeated migration execution and concurrent locking. Performance checks
must retain all members and complete original publication revalidation. Synthetic
timings are not a guarantee of live response latency.
