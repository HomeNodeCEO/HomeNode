# Custom neighborhood retained subject inputs

This slice reads the actual existing Custom assignment → workfile → report →
case → subject snapshot and three assignment-scoped physical-input sections.
It retains a complete original-input bundle in the immutable organization-scoped
blob storage introduced by PR #667. It adds no route, migration, provider call,
file creator, head/current-selection writer, or automatic report mutation.

## Contract and ownership

`createCustomCohortSubjectRepository(client, scopeJson)` binds one exact
organization, report UUID, **bigint text** assignment ID and account string. The
caller must have freshly authorized the exact assignment and own the checked-out
client, bounded transaction, final freshness check, commit/rollback and cleanup.
Neither a guessed blob hash nor this repository grants permission. No global
pool or generic externally authenticated blob endpoint may call it directly.

`capture()` requires an existing draft workfile without a signature and takes
NOWAIT locks in assignment, workfile, report, case, snapshot, section order. It
checks the actual server transaction identity across its first two statements,
rejecting a checked-out client accidentally left in autocommit mode. The caller
must still keep that transaction/client exclusively owned through completion. It
verifies the real report's Custom-only mapping and organization/account links.
It requires a valid nonnull snapshot-or-case effective date; two supplied dates
must agree. No current date, new snapshot, missing file, or empty replacement
section is manufactured. Missing sections are retained as absent, not `{}`.

Original PostgreSQL row/section wrappers retain exact `pg_text` values (including
decimal spelling and unconsumed manual fields). Complete snapshot facts and
provenance use the accepted explicit snapshot preimage; the legacy checksum
remains a distinct field, not the new blob digest. Current physical inputs use
the existing closed Custom material projector. Both current and snapshot values
are preserved, including disagreement; neither wins implicitly.

Each database-returned wrapper is bounded at 1.5 MB before transfer; the existing
projector/scanner's node, depth and numeric admission rules also apply. All five
canonical blobs are preflighted before the first insert, including string-escape
growth. Failures are not truncated or converted to success. Repeated identical
content reuses the same references. SQL errors propagate to the transaction owner.
The bundle digest includes original unconsumed fields for evidence retention;
future current-use comparisons must compare the closed material projection, not
invalidate an analysis merely because unrelated prose changed the bundle digest.

`load(bundleRef)` rechecks the current exact report/assignment tenant/account
mapping, then reads only original retained references. It does not chase a newer
case/snapshot, require draft status, or read fresh property/section data. It
reprojects and compares material and snapshot evidence byte-for-byte, rejecting
missing, corrupt, cross-target or semantically inconsistent references. Fresh
history-read authorization and source-retention policy remain the caller's job.

## Deliberate non-claims / remaining integration

The bundle is explicitly `usage: retained_subject_inputs_only`. It is **not** an
IssuerTargetContextBodyV1, immutable selection roster, acquired source capture,
human-fact authority, signed output, or a ready statistics result. The capture
operation alone does not establish a shared deadline/private completion channel
or enroll every material writer in a current-use fence. Current physical-input
versus snapshot differences remain unresolved until the workflow-owned semantic
reconciliation step chooses an authorized correction/recapture. Do not infer
that an empty `accepted_evidence` projector list establishes accepted-source
completeness or that the storage timestamp proves historical availability.

Next integrate this concrete resolver with original selection/study definitions,
the setup-operation/target-head store and genuine acquisition dispatch. Then
connect complete source populations and one coherent Custom area/statistics
Apply/save/reopen operation. No UAD-specific activation is added by this slice.

## Verification

Unit tests cover exact IDs, tenant/file binding, original spellings, explicit
dates, missing/protected workfiles, fail-closed size limits, semantic corruption,
replay and historical reopen after live edits. The existing guarded CI-only
PostgreSQL child database runs the real queries against ordinary migrations,
verifies rollback and original history, and uses two clients to test NOWAIT at
all six lockable rows. No shared or production database is a test target.
