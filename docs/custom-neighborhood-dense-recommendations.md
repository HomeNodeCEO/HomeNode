# Complete-roster recommendations for dense Custom studies

## Scope and compatibility

Catalog v2 supports 1,024 named recorded CAD groups plus an unresolved group.
The recommendation kernel and compact presentation now have an explicit v2
representation for that complete roster. Legacy v1 callers retain their 128-name
semantics and exact scoring output. Policy revisions 1–3 still describe evidence
availability, not catalog capacity: weights, curves, thresholds and missing-data
rules are unchanged. No schema, authentication, source rights or report Apply
contract changes are involved.

The owner reuses its already checked indexed observation preview. It does not
expand member tables into duplicate stock/sales objects or reload retained source
data to rank groups. Scores use the entire captured roster as one fixed baseline.
Toggling a group changes the selected union, not the scoring baseline. Every
account, including unknown or conflicting observations, remains in denominators.
The existing GLA40/age30/housing20/remainder10 policy is unchanged. Current CAD
value is not used as a substitute for verified sale consideration.

Large groups are processed with cooperative yields every 125 scored accounts;
the existing owner deadline and cancellation check run between batches. The
existing retained-geometry proximity query, its work limits and read-only
transaction remain unchanged. If recorded proximity is unavailable, that weight
stays unknown. Municipal studies do not invent a radius for the proximity curve.

## Bounded output and coherent state

- v1 public recommendations remain limited to 129 groups / 512,000 bytes.
- v2 allows 1,025 groups / 2,500,000 bytes, still inside the existing 4MB catalog
  transport limit. The owner budgets the optional result, then checks the exact
  final envelope including private-source observations. When it cannot fit, the
  whole optional recommendation is omitted; no ranked prefix is substituted.
- CAD literal detail has separate all-or-nothing detail omission. Counts/ranks
  remain complete; missing builder/HOA/legal/phase information is not invented.
- The browser checks version compatibility, every group identity/count/rank,
  full-population totals, exact context/revision/fingerprint and unchanged policy.
  It rejects duplicate, missing, foreign, reordered or inconsistent groups.
- Suggestions do not automatically replace a saved or explicit empty selection.
  The existing “Use suggested selection” action saves through the normal
  checkpoint path. Map and selected statistics continue to publish together.
- Both exposure checks and final organization/assignment/material/private-source
  checks remain in place. There is no cross-request authority or evidence cache.

## Effective dates

The size upgrade does not turn a later current-CAD capture into historical housing
stock. A capture after the effective UTC day remains available for inspection,
but actionable recommendations and historical report adoption stay blocked by
the existing temporal checks. In particular, Hardy's September11 current capture
does not establish neighborhood stock for its August31 effective date. This
release does not edit that date, create replacement evidence or Apply a report.
An earlier/same-day capture is also not proof of provider coverage or reliability.

## Validation

Tests cover 887 and 1,024 complete groups, 1,025-name catalog overflow, all/subset/
empty selection, legacy score parity, indexed mapping4 housing/literal parity,
unknown members, foreign contexts, cancellation and full browser admission.
Native PostgreSQL tests exercise source revocation, real query timeout, changed
assignments/material, immutable reopen and unchanged accepted report state.

The opt-in `recommendation` phase in `neighborhoodDenseCaptureMemoryChecks.js`
reopens the existing synthetic retained graph under a 384MB Node heap with the
full web application running. It tests current-observation diagnostics only;
it bypasses no production historical gate and makes no historical truth claim.
One local run processed 38,106 accounts, 38,347 parcels, 887 groups and 421,817
coordinates. Recommendation projection was 781,542 bytes; the full catalog,
recommendation, map and statistics envelope was 25,294,808 bytes. Ranking and
projection added about 2.64 seconds after the catalog; total reopen/presentation
was 27.10 seconds. Peak process RSS was 523,696KiB. All 168 ordinary HTTP probes
succeeded (p99 about 1.48 seconds). These are diagnostic measurements, not a
production latency promise or a controlled comparison with another run.

County-name identity compatibility, historical-stock evidence and additional
read-speed improvements remain separate work. Recorded parcel labels are not
legal subdivision boundaries, and similarity/COD must not be called reliability.
