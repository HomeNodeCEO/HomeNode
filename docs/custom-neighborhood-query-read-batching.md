# Retained query-evidence read batching

`customCohortSelectionRepository.load` reads siblings from a fully checked
query-bundle header in batches using the existing scoped blob repository.
Each batch is limited to eight originals and 2,000,000 declared UTF-8 bytes.

The header, per-reference and complete-bundle limits are unchanged. The original
subject integrity read still precedes query-evidence reads. Every returned
original is freshly validated for exact canonical bytes, hash, length and
storage representation. Returned evidence retains the header's reference order
even if database rows arrive in a different order. Final complete query grammar
and subject binding checks remain mandatory.

There is no cross-request cache, new query pool, parallel query on the caller's
transaction, source/authorization policy change, schema change, or write in
`load`. Reopening after a successful read still rejects subsequently missing or
corrupt originals. Driver failures stop without retrying or returning a partial
graph.

Synthetic fixtures compare the full result with the previous sequential read
path. A 38,106-account query bundle uses six batch reads instead of 42 individual
query-original reads; the complete selection load uses 13 statements instead of
49. A 50,000-account fixture uses seven instead of 53 query-original reads.
These are exact fixture query counts, not production latency or throughput
measurements. Source-row reopening and calculation costs are separate.

When a missing reference and a corrupt returned original share a batch, the
storage validator can detect corruption before the missing slot is inspected.
The previous sequential path could report the missing reference first. Both
outcomes fail closed; no simultaneous-fault priority guarantee is introduced.
