# Captured stock distribution comparison

The Custom subdivision inspector has an optional, initially collapsed **Property
distribution comparison** panel. It compares the inspected subdivision/phase and
the current selected union with the subject's existing subdivision review family.
It does not change map colors, relevance weights, selections, accepted report
statistics, or the boundary-and-statistics Apply transaction.

## Exact population and interpretation

- Every unique captured account belongs to exactly one original catalog leaf,
  including nonempty unassigned stock. Parent/phase/selected counts are exact
  unions of these leaves, not averages of phase medians or sampled accounts.
- GLA, year built, and site area use four bins defined by the complete capture's
  Type-7 quartiles. Ties go right. Repeated cuts remain repeated, with empty
  zero-width bins. Bins may only be compared within the same retained context.
- The existing preview's observed and partial numeric values enter the bins.
  Missing, invalid, and conflicting observations are never imputed. Housing
  uses the unchanged, mapping-specific recorded-housing interpreter; only
  observed categories enter its comparison.
- Overlap is `100 * (1 - sum(abs(p_i - q_i)) / 2)`. It is unavailable if either
  observed distribution is empty. Coverage is displayed separately. A 100%
  binned overlap does not mean identical properties or identical full-value
  distributions, and is not calibrated reliability or sales representativeness.
- The reference must be the unique existing review family containing the
  subject's recorded leaf. Missing or ambiguous membership has no nearest-name
  fallback. This does not establish legal subdivision identity or population
  coverage outside the captured area.

## Boundaries and compatibility

The optional `stock_composition_v1` recommendation sidecar is derived from the
already admitted preview/catalog, resolved subject, and recorded housing. It
performs no source queries, writes, source-rights changes, or new subject fallback.
Its fixed definition and hash pin count ordering, units, bins, and limitations.
The browser checks the complete partition and exact context before rendering.

The sidecar supports up to 50,000 accounts and 1,025 original leaves within
256,000 UTF-8 bytes. Unsupported capacity returns a whole unavailable envelope;
transport composition may omit even that envelope if it cannot fit. It never
evicts existing recommendation or CAD evidence to fit new data. Older responses
without the sidecar remain usable. Historical-current-stock restrictions remain
unchanged; this panel is not a substitute for historical source evidence.

The synchronous and cooperative APIs use the same kernel. Cooperative iteration
yields no partial result and remains under the owner's existing request budget.
Tests cover complete capture/reopen mappings, byte/profile parity, malformed
counts/bindings, uncertainty, quartile ties, cancellation, and the 50,000-account
limit. Timing diagnostics are synthetic measurements, not production guarantees.
