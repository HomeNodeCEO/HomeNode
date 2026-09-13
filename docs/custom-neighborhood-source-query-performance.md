# Neighborhood source-identity query performance

The source-authorization reader and the source-capture reader independently
discover the same one-hop sale identities. Neither read may be removed: the
second comparison detects changed associations before retaining market facts.

## Large-roster query selection

For fewer than 10,000 selected accounts, retain the original fixed array-membership
SQL. At 10,000 or more, use a shared fixed query that materializes the selected
account array once and joins each of the same three discovery arms to it.
This is an internal execution choice, not a request option, larger account grant,
new source mapping, changed selection, or new database schema.

Both queries retain:

- Primary source-account matches, secondary parcel-link matches, and linked
  legacy-sale matches, combined with distinct `UNION` semantics.
- Exact account equality, numeric source-ID cursor/order, bounded page size and
  the existing lookahead row. No new date, status, resolution, price or unit filters.
- Null handling and orphan identities so the existing completeness checks can
  reject missing source records rather than silently discard them.
- Discovery from the original selected accounts only, never a recursive search
  from additional accounts encountered through a linked transaction.
- Existing read-only snapshot ownership, authorization, drift validation,
  record/byte/deadline limits, source retention and failure behavior.

## Measurement and limits

A bounded read-only production-database diagnostic used a non-geographic catalog
range of 38,106 accounts. Three alternating first-page pairs returned identical
251-row payloads, byte counts and order. Current query wall times were
766.869/805.786/800.369 ms; candidate times were 335.628/246.274/136.033 ms.
One later pair was also identical: 905.364 ms current versus 192.428 ms candidate.
The complete diagnostic finished in 5.425 seconds without data or report writes.

These timings include client query handling, planning and execution. They do not
isolate a PostgreSQL phase, establish a general speedup, prove a geographic
cohort's completeness, or demonstrate that a full capture meets its deadline.
The 10,000-account threshold is a conservative implementation choice, not a
measured crossover point; additional roster distributions should be profiled.

Plain query-plan estimates alone were misleading here: the candidate's estimated
cost was higher, despite lower wall time in this bounded comparison. Conversely,
a parcel key-first experiment showed no useful local improvement and introduced
duplicate-ID join risks; that unrelated query rewrite was not adopted.

Maintain native differential coverage for both query paths and their threshold.
Future cursor, index or paging optimizations must preserve the two independent
reads and all source identities, not obtain speed by reducing the evidence set.
