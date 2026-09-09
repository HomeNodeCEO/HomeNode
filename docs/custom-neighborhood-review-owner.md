# Custom review transaction owner

The existing `createCustomCohortContextCapture({pool, authorizeMarketData})`
factory now provides an internal `review` method. It composes the immutable
review-command repository with the established Custom access and retained-source
policies. It adds no HTTP route, production mount, permission, UI or supported-fact
interpretation.

```js
await owner.review({
  auth, // authenticated server principal, never a browser body field
  accountId,
  assignmentFileId, // exact bigint text
  commandJson, // original bounded v1 command JSON string
}, { signal, deadline });
```

The owner rejects extra input fields and mismatched target identity. It uses the
existing workflow-write and exact assignment-write rules; there is no new reviewer
role exception. The reviewer UUID comes only from the authenticated principal.
It authorizes the retained source purpose before the repository opens the source
graph, then checks assignment access and source policy again before COMMIT.
The private `loadInputs: false` option skips a redundant graph load in that first
policy check; it never skips permission or evidence validation and is not a request
option. Actual subject/material, signed-state, context/generation/predecessor and
canonical-record checks remain in the repository.

Initial denial reads no raw retained sale records. Final denial, cancellation or
failure rolls back the entire review transaction, including its new blob and index
row. Connection, query, lock and overall deadlines use the existing coordinator
limits. An uncertain COMMIT reports `outcome_unknown` rather than claiming failure
proved rollback; exact authorized command/actor replay returns the recorded result.

Only after COMMIT does the caller receive:

```js
{
  status: 'review_recorded', reused, context_ref, decision_ref,
  generation, authority: 'not_established',
}
```

This opaque receipt contains no original command, source field, raw record,
reviewer label or diagnostic. Its generation is that operation's recorded
generation, not necessarily the newest context generation on historical replay.
Retention permission is not treated as permission to expose individual MLS fields.
Review-field inspection still needs its separate authorized presentation path.

Final assignment checks reuse the authenticated role snapshot while rereading the
actual assignment; they do not add an in-flight session/membership revocation
protocol. The source policy is actually reread. The internal factory has bounded
deadlines, not an HTTP rate limiter. Any future route must keep the established
session/bearer, CSRF, parser, rate, exact-target and source-exposure boundaries.

## Verification

`customCohortContextReview.test.js` exercises the actual owner, repository,
evidence binder and retained loader with transaction-aware query fixtures. It
covers the COMMIT barrier, exact replay, single graph load, access denials,
source-policy changes, assignment reassignment, cancellation and uncertain
COMMIT outcomes. These fixtures do not claim native locking guarantees.

`customCohortReviewDatabaseChecks.js`, invoked by the existing migration-backed
integration suite, also exercises the actual owner against PostgreSQL. It checks
commit/reopen and historical replay, denies unauthorized work before retained
reads, and observes tentative review/blob rows inside the transaction before a
final policy denial. It then verifies those rows are absent after rollback and
that accepted report/workspace sections are unchanged. Its principal and source
grants are synthetic, not evidence of production activation.
