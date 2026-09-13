# Report proposal interruption diagnostics

Report preparation retains its existing 60-second aggregate budget, including
the one-second cleanup reserve. This change does not extend deadlines, retry
queries, skip validation, or change report/source permissions or publication.

An expired or cancelled owner operation can fail both a repository statement
and the subsequent savepoint cleanup. The repository still throws the same
`AggregateError` containing both original errors. A private, identity-only
`neighborhoodCallerCleanupFailure(error)` lookup recognizes only aggregates
created by that repository. Its frozen pair is one level deep; copies,
lookalikes, wrappers and nested errors do not confer classification authority.

After its existing outer rollback attempt or connection-discard decision, the
Custom owner can annotate that exact aggregate with the original fixed code and
reason only when its primary error was issued by the owner as
`deadline_exceeded` or `cancelled` and still has that exact typed pair. The
aggregate, its message and both children remain intact. Cleanup SQL continues
to use the existing budgets; failed connections are discarded, and a release
failure still supersedes an ordinary interruption.

The existing router consequently reports HTTP 503 with
`neighborhood_request_interrupted` for these proven interruptions. An attempted
COMMIT, or an `outcome_unknown` flag on the original failure or either known
child, takes precedence and preserves HTTP 409 with same-operation recovery.
That uncertainty also survives a release failure. No automatic retry occurs.

Only the fixed proposal diagnostic `{action, family: 'coordinator', check}` is
logged for these two interruption reasons. Raw error messages, SQL, children,
source values and identities are not logged or returned. Plain driver timeouts
are not recognized by message text; unknown errors remain HTTP 500. SQL-state
mapping and unrelated routes retain their existing behavior.

The focused regression suite uses controlled clocks, actual owner/repository
code, SQL-result doubles and direct route-handler invocation. It checks
enqueue/claim/publication interruption, rollback/discard/release behavior,
uncertainty precedence, identity-only provenance and sanitized transport. These
tests are not a native database or live performance claim.
