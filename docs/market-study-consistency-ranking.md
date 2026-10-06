# Market study consistency ranking

Market recommendation methodology version 3 ranks the independently calculated
study areas by their population consistency, not similarity to the subject or
the number of sales. It does not pool overlapping study areas.

The existing composite COD and CV retain their characteristic weights:
living area 40%, age 30%, housing type 20%, sale price 5%, and price/SF 5%.
Unavailable factors are omitted and the remaining weights renormalized.
Invalid negative or non-finite dispersion is not an observation.

For an available composite COD and CV:

```
mean dispersion = (composite COD + composite CV) / 2
reliability score = 100 / (1 + mean dispersion / 100)
```

The score is a consistency index, not a statistical confidence probability.
Lower dispersion produces a higher score. Either missing composite measure
leaves the score unavailable rather than treating missing data as zero.
Scores display to one decimal; ties compare the composite mean before using
sale count as a final tie-break. Both the server recommendation and browser
split-response reconciliation use this order.

Sales counts, the below-30-sales warning, monthly observation counts,
characteristic coverage, and location-coverage warnings remain separate.
They do not raise or lower the consistency index. Review partial characteristic
coverage before relying on a high score from a limited set of characteristics.

This change adds no SQL, map geometry processing, capture, source acquisition,
membership filtering, or database maintenance. Observation dates and sales
eligibility are unchanged. Annualized changes, mean/median trend reconciliation,
the stable threshold, and historical legacy custom-polygon weighting are also
unchanged. The new Exploration Map Area remains an independent study.

Stored workfile results are not silently rewritten. Rerun the market studies to
replace earlier scores; their methodology version identifies the older method.
Mixed-version split responses retain the older methodology indicator instead of
claiming that all their scores use version 3.

Regression coverage includes tighter versus larger populations, sample and
monthly-coverage invariance, missing/invalid measurements, rounded-score ties,
split-response/server parity, and unchanged selection/context bindings.

## Appraiser-selected reconciliation (October 2026)

The ranked cards now select the studies used for the recommended determination.
Apply selected studies reconciles only those studies' annualized changes as the
mean of their average and median, with the existing 1% stable threshold. It
regenerates a reviewable explanation; selecting a checkbox alone never overwrites
an edited explanation. Completed study results remain unchanged, and applying a
different combination sends no market, map or capture request. Save market
reconciliation persists the choices through the existing workfile section/CAS.

Callback-owned report editors hydrate only from the exact database workfile
draft, including when that draft arrives after the lazy editor mounts. They
never republish a stale browser draft over saved weighting, land use, or form
review fields. Standalone editors retain their exact-file local draft fallback;
late hydration still cannot overwrite an appraiser's intervening edits.

Past six- and three-month changes compare the exact end-month sale-price median
with the median six or three months earlier. They are not fractions of an annual
rate, do not infer a missing endpoint, and do not control the annual trend label.
Trailing 12/6/3-month marketing medians are calculated over the existing eligible
closed-sale observations in one SQL query (calendar months ending at the chosen
study end). The selected-study mean/median reconciliation is an estimate across
independent study medians, not a pooled-sale median; overlapping populations are
not added together. Missing period evidence stays unavailable with contributing
study counts shown. The study observation dates, not appraisal effective date,
continue to define these windows.

Trend classification compares the unrounded annual estimate with the existing
stability threshold; only displayed/saved percentages are rounded. A selected
study marked `sample_sufficient: false` remains usable but the determination
and saved explanation identify its estimate as provisional. This warning does
not alter COD/CV ranking or prevent appraiser-reviewed export.

Present land use is a separate protected retained-selection operation. It uses
the existing indexed `gis.dcad_parcels` mirror, includes exactly one layer of
edge-sharing neighbors (rook adjacency: `&&` then DE-9IM `F***1****`), and does
not include corner-only touches or recursively expand the neighborhood. This
adds no neighbor sales to any market study. Percentages use dissolved parcel
acreage, including nonresidential neighbors, not parcel counts. Roads/nonparcel
gaps are excluded; unknown classifications remain an unclassified remainder,
never manufactured Other. Missing geometry/provisional classifications are
flagged. Cross-category overlaps and oversized populations do not produce
misleading percentages. A read-only 50-second database deadline, existing
bounded execution gate, five-minute numeric cache and post-work authorization
recheck preserve existing capacity and access boundaries. No CAD download,
cron job, new schema, or feature-flag activation is added by this change.

Native adjacency regression runs only against verified loopback `*_test`
PostGIS, using temporary synthetic rectangles. See
[PostGIS ST_Relate](https://postgis.net/docs/ST_Relate.html).
