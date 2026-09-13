# Same-payload reported sales interpretation

This slice adds an explicit, dormant local interpretation profile for original
mapping5 captures with witness2. It does not activate new production captures,
change source permissions, reinterpret saved reports, or change the map preview.
The workflow owner continues issuing mapping4 and refusing mapping5. Existing
SharedSales and ReportAssessment entry points retain their previous outputs.

## Why a separate profile

An import can preserve a nonempty typed database value while replacing the raw
payload. Pairing that old number with a newer raw unit, date, or status can create
a combination that never appeared in one source record. The new explicit path
uses six values and their metadata from the same retained witness: ClosePrice,
CurrentPrice, LivingArea, LotSizeArea, YearBuilt, and DaysOnMarket. Typed values,
canonical transaction amounts, CAD measurements and alternate fields are not
fallbacks. The original graph remains immutable disagreement evidence.

The exact definition is exported by
`getCustomCohortReportedSaleWitnessV2Profile()`. Its identifier is
`custom-local-reported-sale-witness-v2`, revision `1`, SHA-256
`831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e`.
This is a bounded local syntax policy, not an official NTREIS/Trestle dictionary,
an independent verification of a transaction, or a permission grant.

## Interpretation and conservation

- ClosePrice and CurrentPrice each require their own explicit USD currency.
  Generic Currency/PriceCurrency can veto contradictory evidence but cannot
  establish a missing field-specific currency. The other price's currency does
  not supply or invalidate this price's currency.
- LivingArea and LotSizeArea require their own explicit supported area unit.
  Supported local aliases resolve to sqft/sqm, with acre also allowed for sites.
  No conversion or preferred-unit subset is chosen. Mixed observed units retain
  every record and all observation counts but have no pooled statistic.
- MlsStatus must report closed; StandardStatus is a consistency check, not a
  substitute. CloseDate uses strict ISO or US calendar syntax. Unavailable date
  evidence is unsupported, not silently missing or invalid. The complete
  selected source population uses the inclusive saved observation period.
- Numeric strings never pass through floating point. Inputs retain exact
  scale12 magnitude; an even median can have13 decimal places. Reported zero
  prices/site areas are observations, not proof of consideration or usable land.
- Each source identity contributes once. Duplicate wrappers must carry identical
  complete witnesses. Full account associations, including outside-discovery and
  unresolved links, remain intact; package prices are not allocated.
- Observed, missing, invalid, conflicting and unsupported counts conserve every
  included source record. No top30 sample or price-ratio filter is introduced.

## Explicit internal APIs

`interpretCustomCohortReportedSaleWitnessV2(witness, effectiveDate)` interprets a
single checked witness. `buildCustomCohortReportedSharedSalesWitnessV2(input)`
uses the existing complete retained-graph traversal and association rules.

`buildCustomCohortReportedAssessmentWitnessV2(input)` and its cooperative
`buildCustomCohortReportedAssessmentWitnessV2Batched(input, options)` counterpart
retain the exact interpretation definition and reference in shared-source
publication evidence. Source/member digests then bind those semantics to the
reported values. They preserve the existing target, historical-stock, selection,
manual-geography, publication and cancellation checks. Boundary and statistics
continue to form one report candidate, never independently applied fragments.

No caller can supply a replacement interpretation dictionary or enable these
rules by changing a mapping number. Existing default entry points do not invoke
the new interpretation. A later workflow change must explicitly persist/select
this exact profile for new derivations and retain previous semantics on replay.

## Validation and remaining work

Tests use original synthetic mapping5 acquisition, retention and verified reopen
with deliberately different raw and typed values. Default mapping2/3/4/5 output
hashes are pinned. Coverage includes malformed witnesses, metadata conflicts,
calendar limits, exact decimals, heterogeneous units, more than30 records,
complete associations, empty selection and report evidence binding.

The current reader admits one transaction row per source identity. Additional
duplicate-wrapper tests are explicitly downstream defense tests on detached
fixtures, not claims that such a graph passed original acquisition.

Activation remains separate: exact source-purpose authorization, persisted
profile selection, source field availability, and UI projection must be wired
and tested before production uses these values. This does not establish
historical CAD stock, verified GLA at sale, economic-property equivalence,
market eligibility, reliability, predominant values, builder/HOA facts or
provider coverage. Unknown evidence remains unknown.
