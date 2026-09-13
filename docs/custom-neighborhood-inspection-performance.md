# Custom neighborhood inspection reuse

This change affects the subdivision review dialog, not saved inclusion choices,
map appearance, source interpretation, or report Apply.

## Request ownership

- An inspector waits 250 ms before hashing or admitting a request. Closing or
  changing it during that interval cancels the work. The existing 65-second
  deadline and active shared-request lane ownership remain unchanged.
- A family with 2–32 phases requests one no-map summary using the existing
  preview endpoint. Each phase contains the exact union of its recognized
  recorded CAD leaves. The selected population is the whole family's union.
- Switching phases in that open dialog displays the matching pocket result
  from the same checked response. It does not recompute statistics, average
  medians, sum overlapping sale counts, or relabel the parent as a phase.
- The frozen batch's structural session identity is memoized. Phase-only and
  response-state renders do not serialize every account again. A copied equal
  batch preserves its session; changed membership or target/context resets it.
- Record pages still make authorized requests with the complete original batch
  selection fingerprint and the exact pocket population descriptor. Switching
  populations clears the prior record page and continuation.
- No response is cached across dialogs, contexts, files, or sessions. A changed
  context or batch membership remounts the inspector. Existing save/finalization
  pauses still prevent new reads and identify retained results as paused.

## Complete fallback

The 32-phase budget limits batching, not the population. Single-phase families,
larger families, private-CSV contexts, and names incompatible with the existing
request grammar retain complete independent inspection. No label is truncated.
A settled batch-capacity refusal falls back to the complete requested group;
permission errors, timeouts, and malformed responses do not silently retry.
Private supplements have no per-pocket presentation contract, so parent private
statistics are never displayed as phase statistics.

## Verification

Synthetic regression tests use actual mapping4, preview, and presentation code.
They compare full standalone phase results and members to bundled phase results,
and the parent union to `selected`, including missing/conflicting CAD values,
out-of-period and missing-date transactions, multi-account transactions,
unresolved links, and source-only records. Selection hashes and member cursors
remain bound to the original batch and requested population.

The optional synthetic benchmark can be run from `server` with
`HOMENODE_PHASE_BUNDLE_BENCHMARK=1` and
`node --test test/customCohortPhaseBundlePresentation.test.js`. It reports timings
without asserting a timing threshold. It does not measure database, retained
evidence reopening, network, production data, or browser latency.

First opening still performs the existing full authorized retained-evidence
validation. Reducing that work must preserve original-byte validation, tenant
and assignment authorization, current source rights, and final freshness fences.
