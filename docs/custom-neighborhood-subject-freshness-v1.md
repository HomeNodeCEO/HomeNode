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
