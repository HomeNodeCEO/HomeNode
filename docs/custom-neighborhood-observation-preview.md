# Retained Custom neighborhood observation preview

`buildCustomCohortObservationPreview({ context_ref, retained_inputs, selection })`
is a pure numeric consumer. `retained_inputs` is the exact frozen graph returned
by `loadCustomCohortCaptureInputs`; the caller owns authorization, context/target
resolution, retention verification, transaction cleanup and current-editor checks.
The function performs no SQL, writes, source requests, geometry parsing or Apply.
Its defensive shape checks are not a replacement for that owner workflow.

`selection` contains a positive integer `revision` and
`pockets: [{ id, label, account_ids }]`. Each account must belong to the retained
spatial roster. Pocket membership is a current appraiser selection, not a claim
that the accounts are comparable, housing-eligible or historically supported.
An empty selection stays empty. Overlapping pockets have independent results;
the `selected` result uses their deduplicated union. `all` always uses the whole
retained roster and all captured canonical transactions in the study period.

## Three different populations

- `stock`: one member per selected account, including accounts missing CAD
  observations. Parcel objects are counted separately. Multiple CAD rows must
  agree on a field; values are never summed across parcel objects. Assessed values
  are current CAD observations with unknown tax year, not sale or market prices.
- `transactions`: one member per stored canonical transaction with a consistent
  in-period canonical closing date. Repeat sales remain separate transactions.
  Canonical price conflicts/missing values remain in the price denominator as
  missing. Package totals remain whole; all observed associated account identities
  and unresolved links are retained, including accounts outside a pocket. These
  identities are not verified economic-property membership or eligibility.
  Missing/conflicting/out-of-period dates are retained under `omitted` with reasons.
- `source_reported`: one member per retained source record, over **all captured
  dates**, including listings and source-only rows. Source prices, living area,
  lot area and other physical fields are not canonical sale facts or CAD stock
  facts. Source area units were not retained and are not invented. Only CAD fields
  explicitly named in square feet carry `ft2` units.

All source chunks are consumed. The `exactDistribution` estimator uses every
supplied member, with Type-7 quantiles; there is no 30-sale cap or tail trimming.
Its `state: ready` means enough observations for the descriptive calculation,
**not** report readiness. `interpretation: captured_observations_only` accompanies
each distribution. `missing_count` includes conflicting/invalid/absent members;
the separate counts explain why. Known values accompanied by missing duplicate
rows are reported as partially observed. Explicit zero is retained where valid;
zero living area is invalid and never becomes a PPSF denominator.

Member observations retain original numeric primitives in `raw_values` and an
unrounded decimal `exact_value` where values agree. Exact decimal comparison
prevents large-number conflicts disappearing through floating-point conversion.
The existing statistics engine computes using JavaScript numbers; format only at
the display edge and do not round or overwrite retained observations. Currency
is always unknown here: a stored numeric amount is not proof of currency.

Each member carries `{ source_ref, record_id }` references into the retained
source routing; source snapshots are included for provenance display. These are
lookup references, not permissions or cohort-decision admission proofs. The
output is internal assignment-private data. Do not forward all rows to a browser
without the owner's licensed-data exposure policy and bounded presentation.

## Unavailable conclusions

The top-level result is always `observations_only`, with authority
`not_established` and Apply blocked. Historical housing facts, market eligibility,
sale completion/consideration, currency, complete property membership, allocations
and GLA at sale are not inferred. Property sale price, sale PPSF, ages at sale or
effective date, predominant value and underlying market change remain unavailable.
Median is not predominant; COD describes dispersion, not reliability. UI should
show data-support gaps and observed/missing coverage, not a synthetic reliability
score. Captured-dataset coverage is not real-world market completeness.

Work budgets and a 32 MB serialized-output ceiling reject the whole calculation;
no truncated preview is returned. Repeated members in overlapping pockets are
charged for each output occurrence, even when the internal object is shared.
Pocket, record, member/reference and measurement budgets are implementation safety
limits, not cohort-size or sale-sufficiency policies. Map geometry, route/editor
wiring, reviewed fact admission and supported-assessment Apply are follow-up work.
