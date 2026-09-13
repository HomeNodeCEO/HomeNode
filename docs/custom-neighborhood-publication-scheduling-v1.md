# Cooperative Custom neighborhood publication verification

The Custom report-proposal owner independently verifies the complete assessment,
member roster and captured source payloads again at the repository boundary. That
verification is required even when report assembly already checked a proposed
bundle. This change schedules the same verification kernel cooperatively; it
does not trust an earlier prepared result or remove a validation pass.

## Scope and ownership

- The asynchronous entry point is available only on the explicitly caller-owned
  transaction repository. The generic pool repository and existing synchronous
  publication preparation retain their behavior.
- The caller-client reservation covers input sealing, every cooperative yield,
  the existing savepoint, and publication. Concurrent use of that repository is
  refused while the reservation is active.
- Claim and publication inputs are sealed before the first suspension. The
  iterator exposes no partial members, hashes, receipts or validation authority.
- The existing owner budget is checked between bounded verification steps;
  cancellation closes the iterator and releases the reservation. The owner
  retains responsibility for its outer transaction and cleanup.

## Unchanged guarantees

Publication still verifies all member and source content, storage limits,
population counts, digests, scope, effective date, input signature, claim token,
lease and revision fences. Both entry points use the same SQL publication body.
Source and member INSERT ordering, batch sizes, savepoint cleanup and final
publication promotion are unchanged.

This is a request-responsiveness change, not a reduced-data algorithm or a promise
that total report-proposal work is instantaneous. No request deadline is raised.
No authentication, source-use policy, schema, report calculation, map selection,
accepted-report Apply behavior or frontend layout changes.

Fixed operational report-phase durations cover the initial retained load, report
assembly, final publication transaction and repository subphase. The last is
inside publication, so their durations must not be summed. Logs contain no
request identities, source values, SQL or error messages; logger failures cannot
change transaction recovery or the returned result.

## Validation

Regression coverage compares the existing and cooperative paths, including
canonical results and SQL parameters, late content failures, cancellation,
input mutation and concurrent caller use. The full server and native database
suites remain required. Dense synthetic owner replay measurements are kept as
private diagnostic artifacts rather than timing assertions in ordinary CI.
