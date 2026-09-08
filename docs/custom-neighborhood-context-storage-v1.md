# Custom neighborhood context storage

This slice implements immutable **header retention**, not the live context issuer
or an authorization grant. There is no new HTTP endpoint or production caller.
The Custom-only context header follows the c74 context-capture proposal: its
identity binds the exact organization, report, assignment (positive int64 text),
account, case, snapshot/version, effective date and four evidence references.
The context digest uses the `cohort-issuer-context-v1` domain and is intentionally
different from the canonical header blob's content digest.

## Storage and caller responsibilities

`createCustomCohortContextRepository` uses a checked-out caller client and verifies
that the operation remains in one actual PostgreSQL transaction. Every lookup is
bound to an organization and exact file/account; the permanent report/assignment
relationship is checked without substituting today's snapshot for retained history.
The new table's composite foreign key also binds the report's organization,
assignment and account. An existing context UUID can only replay identical data.
Its row and referenced canonical blobs cannot be updated, deleted or truncated
through ordinary SQL. Existing migrations are unchanged; the new migration is
registered with the shared application migration runner.

The caller must establish fresh original-request workflow authorization, hold
the ordered target/identity/material fences, validate the full source/dependency
graphs and installed profiles, enforce cancellation/deadlines, and own rollback
or commit. This repository checks the four top-level blobs' exact stored bytes;
it **does not** validate their domain semantics or certify acquisition completion.
Neither a self-consistent hash nor a `stored` result grants authority to issue
facts, select a current analysis, apply statistics, or sign a report.

## Integration still required

- Bind these exact headers to the private, freshly authorized setup/acquisition
  runtime and resolve the complete subject, selection and study dependencies.
- Install the actual complete three-mile database discovery producer and source
  completion tracking, keeping incomplete coverage explicit.
- Select boundary, pockets, criteria and statistics as one coherent current
  group; saving/reopening must retain that same group and its original evidence.
- Validate live Custom reports, including Hardy, Snowmass and Aaron, before
  declaring the feature ready for appraiser use.

Tests cover closed canonical representations, exact int64 identity, immutable
replay, absent/conflicting references, corrupted/missing evidence and transaction
ownership. The canonical native suite additionally runs the real PostgreSQL
constraints, caller rollback and two-client cases; mocked tests alone are not
evidence of database locking or foreign-key behavior.
