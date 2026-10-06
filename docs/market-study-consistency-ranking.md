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
