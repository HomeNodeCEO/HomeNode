# Custom neighborhood editor reopen

`GET /api/accounts/:id/assignment-files/:fileId/workfile/neighborhood` is a
dedicated, authenticated editor read. It does not alter the existing workfile
response, readiness, signed snapshots, JSON downloads, or PDF bytes.

The existing workflow and assignment guards run first. The reader then opens one
`REPEATABLE READ READ ONLY` transaction, checks the same assignment policy using
the server session identity, and resolves the exact assignment/account/report/
organization relationship. The operation ID comes only from the stored
`neighborhood_assessment` section. The immutable acceptance, original actor,
history, complete mapped values, and receipt are verified against that same
section and revision. Browser-supplied report/operation/reviewer identifiers are
not used. There is no latest-file, latest-analysis, or account-history fallback.

The response is `accepted` with the verified acceptance, or `not_accepted` only
when the assignment has neither the reserved section nor a retained acceptance.
A missing/broken link, changed current group, or invalid persisted evidence fails
closed instead of silently returning old statistics or an empty/new-file state.
Signed status, signature metadata, and retained signed snapshots require the
existing immutable signed-download path. Archived unsigned files are not editable
through this read. All HTTP outcomes are `Cache-Control: no-store`.

The reader does not initialize schemas/workfiles, write timestamps, apply data,
fetch GIS providers, or poll. Application migrations must be installed before
calling it. A missing storage relation produces an explicit unavailable response.
The route uses existing readiness checks; no global auth/middleware changes were
made. The checked-out connection is released on success and failure, and discarded
when transaction state is uncertain.

## Frontend integration still required

This response is internally coherent, but a separately fetched base workfile can
represent a different snapshot. Before hydration, the frontend must compare the
selected assignment, operation, and accepted section revision. It must never
overlay a newer receipt onto an older base section, use a browser draft in place
of a rejected group, or apply fields piecemeal. No UI polling or automatic Apply
is enabled by this route.

The authorized Apply owner, current source/context checks, actual Custom field
mapping, map/report hydration, and real-property acceptance tests remain separate
work. A valid retained acceptance proves a coherent saved group, not that its
underlying source data or appraisal conclusions have been independently verified.

Tests cover route authorization/original identity, exact reopen, empty-file and
broken-group distinctions, signed/archived safeguards, caller mutation, rollback,
and connection cleanup. Native checks exercise the real database read-only
snapshot and a concurrent next-group commit; query doubles alone do not establish
those database guarantees.
