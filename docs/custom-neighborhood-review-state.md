# Current Custom neighborhood review state

`createCustomCohortReviewRepository(client, canonicalScopeJson).getCurrent(
canonicalContextRefJson, expectedGeneration)` reads one complete set of current
reviewer-command heads for an exact retained context. It does not issue supported
facts, run appraisal calculations, authorize a user/source, publish an assessment
or Apply report values.

The caller supplies an already authorized, deadline-bounded client inside an
explicit READ COMMITTED transaction. The input generation is canonical decimal
text, including `"0"` for an empty context. The repository takes a shared NOWAIT
lock on the exact organization/report/assignment/account/context tuple, then
checks the head using a subsequent statement. The existing append path takes a
conflicting update lock. As a result, another review cannot change the set while
the caller consumes it in the same transaction. The caller must end that
transaction; this method does not acquire a pool client or commit it.

Generation ordering explicitly uses PostgreSQL's numeric column, including the
existing append/current-fact queries. The text representation returned over the
JavaScript boundary must not make revision9 sort after revision10.

`status: "current"` means current review heads **within that exact immutable
context and generation**, not current subject material, source rights, current
CAD data or a verified factual conclusion. The consuming owner must retain its
existing assignment, material, signed-state and source-policy fences, and recheck
the expected review generation if later publication/Apply runs in another
transaction. A stale generation must be explicitly reopened, not silently
substituted with the latest result.

## Content and identity

Each fact slot retains only its latest command. A later explicit unknown replaces
an earlier known claim; a consumer must not fall back to the superseded value.
The command, original actor, original claim diagnostic, generation and immutable
content reference remain intact. Historical decision references inside a command
are still historical references, not proof that those dependencies remain current
or semantically sufficient.

The frozen output binds the full target, context reference and expected generation,
with deterministic fact-key ordering and `state_sha256`. Its domain-separated
digest binds each current fact key, decision ID/content digest and generation.
Original record bytes are independently checked against those content references.
Large record collections are not pushed through the shared per-document JSON
canonicalizer or signed-report HMAC code.

## Bounded complete reads

The internal read admits at most 5,000 review heads, 128,000 bytes per stored
record, 16 MiB of original record content and 20 MiB of final output. These are
resource limits on review commands, **not a sales-selection cap**. Metadata is
checked before record content is transferred. Oversized, missing, duplicate,
foreign or inconsistent rows fail; no truncated subset is presented as complete.
Records are loaded in a bounded batch, not a separate database round trip per
fact. The exact context/header is checked once for the set.

## Verification scope

Unit tests cover canonical inputs, exact target/generation, unknown replacement,
deterministic binding, original-envelope integrity, transaction requirements and
resource limits. The existing guarded native review fixture additionally checks
empty and updated snapshots, shared-reader/writer exclusion, stale retry refusal,
foreign contexts, actual numeric revisions9 through12 and unchanged report/history
rows. Unit scale coverage admits5,000 complete canonical heads and rejects the
5,001st before record transfer. Native and protected checks
must pass before release; synthetic fixtures do not establish production source
rights or a completed supported assessment/Apply workflow.

Next consumers should reuse the existing retained evidence resolver and cached
input/statistics/assessment pipeline. No new fact registry, source query, automatic
approval, mutation endpoint, migration or report-replacement policy is introduced.
