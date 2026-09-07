# Custom neighborhood subject freshness

`createCustomCohortSubjectRepository(...).compareCurrent(retainedReference)`
compares original retained subject inputs with actual current PostgreSQL rows.
It uses the same scoped, ordered NOWAIT target/workfile/report/case/snapshot/
section fences as capture, without persisting another evidence bundle.

It distinguishes changed snapshot identity, effective date, complete snapshot
evidence and the closed physical-material projection. Snapshot identity includes
case, snapshot ID and version. An altered public snapshot cannot hide behind an
unchanged identifier. Unresolved or contradictory dates remain failures rather
than being filled automatically.

Unrelated section notes, neighborhood output, editor revisions, save timestamps
and actor metadata are not physical-material changes. Their exact original
values remain retained for history, but comparison does not hash the entire
section wrapper and invalidate an analysis because of an unrelated save.
Snapshot creation metadata is likewise excluded from the already-established
complete snapshot preimage. Actual snapshot evidence, including its manifest
and verification status, continues to be checked in full.

The result is `{status: "matched" | "changed", authority: "not_established",
changed_inputs: [...]}`. This is a data comparison, not a signing permission,
original source-acquisition proof or authorization grant. The caller must obtain
fresh exact assignment access, own a bounded transaction, keep these fences
through its actual operation, and independently verify context/study/generation
and facts. Do not cache a `matched` result for later unfenced use.

Both capture and current comparison require a caller-owned **READ COMMITTED**
transaction, checked from PostgreSQL in the transaction-identity query before
target reads. Other or unknown isolation levels are rejected, not silently
changed. Parent-row locks do not refresh a pre-existing REPEATABLE READ or
SERIALIZABLE snapshot: it can miss a section inserted and committed before the
locks were acquired. READ COMMITTED supplies new command snapshots while the
existing parent/section fences prevent subsequent relevant writes. The native
two-connection regression establishes that old snapshot, commits an absent-section
insert, verifies snapshot invisibility, and requires rejection; its READ COMMITTED
counterpart observes the same insert and reports changed material. Historical
replay is unchanged. See [PostgreSQL isolation semantics](https://www.postgresql.org/docs/17/transaction-iso.html).

Current comparison requires an existing editable unsigned workfile. Historical
`load` retains its separate behavior and does not require the current draft or
snapshot to match. No route is activated and no report calculation or writer
authorization rule changes in this slice.

Tests cover GLA, year built, housing type, null/absent values, additions, land,
location, legal/subdivision text, snapshots and dates; irrelevant save metadata;
autocommit and database error refusal; and no added storage during comparisons.
The existing real PostgreSQL suite also checks changed inputs/history, plus two
actual clients attempting direct section update and absent-section insertion
while a successful comparison holds its caller-owned fences.
# Existing section identity fence

Current capture/comparison also locks every existing section row for the exact assignment, not just the three consumed material keys. An unchanged assignment foreign key does not prevent another transaction from renaming a non-material key into a previously absent material key. A fully consumed, ordered `FOR SHARE NOWAIT` query fences those identities before material reads; unrelated payloads are neither fetched by that fence nor added to the retained projection. Native tests cover contention on a non-material row, attempted key movement during a matched comparison, ordinary non-material edits after release, and detection of a committed key movement. These locks are held only in the caller's real transaction and do not grant authorization.
