# Custom neighborhood acceptance storage

This is persistence infrastructure, not a deployed Apply workflow. It does not
authorize a user, validate a live Custom field catalog, obtain current source
evidence, or grant signing authority. The UAD acceptance writer is unchanged.

## Coherent saved group

`prepareCustomNeighborhoodAcceptanceSnapshot` reconstructs the complete mapped
group and receipt from the exact assessment/attachment. The saved
`neighborhood_assessment` section contains the operation/actor identities,
attachment identity, complete mapped values and closed applied/reused membership
sets together. The returned receipt is derived and is **not** persisted in the
section/history or acceptance row. `reconstructCustomNeighborhoodAcceptanceSnapshot`
rebuilds it with the unchanged shared application-group engine on reopen; no
duplicated receipt/provenance/prepared-value digest claims can poison the immutable
record. Membership and mapped values are keyed objects, independent of JSON key
ordering. A Custom save
advances its section revision by exactly one, within PostgreSQL integer limits.
This reconstruction validates representation; it does not prove that a claimed
reused value was actually present in the current authorized editor.

The additive `20261013_custom_neighborhood_acceptances.sql` migration follows the
existing Custom workfile/history and neighborhood migrations. Its immutable
record links the exact organization, report, assignment/account, attachment,
original actor, operation, saved section history and stored-UTF-8-byte digest.
The database checks the hash of the exact stored text and its closed semantic
section value. Reopen verifies those bytes independently from the reconstructed
snapshot's canonical digest. Harmless whitespace/exponent spelling is accepted;
there is no approximate SQL reimplementation of ECMAScript serialization.
Dedicated `neighborhood_assessment` history is append-only from insertion, not
just after acceptance. Its guard inspects the old row's section key, so an older
transaction snapshot cannot miss an acceptance and alter its history. Renaming
the section cannot bypass this protection. Ordinary unrelated legacy history is
not made immutable by this change.

## Caller-owned transaction

The eventual workflow composition must perform all of the following with its
original authenticated context and the same checked-out PostgreSQL client:

1. Authorize the exact organization/assignment and reject signed/protected state.
2. Acquire real target/editor/source locks in the established order. Compare
   actual current values and provenance; validate the complete final field group.
3. Save the whole dedicated section and its history as one manual-save revision.
4. Call `recordCustomNeighborhoodAcceptance` with that exact history ID (a decimal
   string), attachment ID/revision, original operation/actor and receipt.
5. Commit, then report success. Any failure must roll back **all** owner writes.

The repository uses a savepoint to reject accidental autocommit before insertion.
It never begins, commits or rolls back the owner's transaction, releases the
connection, initializes schema, or changes permissions. Do not call it as a
standalone database-pool query or substitute a caller-shaped attachment for the
exact stored attachment it loads internally.

## Reopen and retry

`getCustomNeighborhoodAcceptance` requires the exact organization, report,
assignment and operation. It verifies the stored attachment, canonical section
bytes, closed decisions, derived receipt, history and currently saved section together. There is no
latest-assessment or account-only fallback. A later section revision makes an old
operation fail as `not_current_section`, rather than restoring stale statistics
over newer edits. Historical rows remain available for a future separately
authorized audit viewer; this getter is deliberately not that viewer.

Only the exact same operation, original actor, attachment, history and group can
reuse an acceptance. A conflicting operation or altered group does not overwrite
an existing record. Map-layer visibility is not an acceptance or analytic edit.

## Verification and remaining integration

The pure snapshot suite checks complete groups, tampering, malformed input and
revision bounds. Repository unit tests exercise database-query boundaries, not
native SQL or authorization. Native persistence checks use real migrations and
published synthetic assessments, with explicit synthetic owner section/history
writes to test rollback, isolation, exact reopen/reuse and immutable history.
Direct SQL cases additionally reject injected receipt fields, extra decision keys,
incomplete/overlapping membership and altered mapped values before immutable insert,
and prove equivalent noncanonical JSON reconstructs the exact shared receipt.
The history tests include an older REPEATABLE READ transaction, pre-acceptance
renaming, and an unrelated legacy-history negative control. Large snapshot tests
keep section and receipt size limits independent during save, retry and reopen.
Those simulated owner writes are not a claim of live route integration.

Before release, complete the actual Custom authorization/source-context/catalog
composition, integrate the separately reviewed transaction-save entrypoint,
prevent legacy hydration from silently replacing accepted groups, and test
authenticated Apply/save/reopen on real test properties. Required suites and
independent review must pass before publication. Do not infer readiness from
schema installation or mocks alone.
