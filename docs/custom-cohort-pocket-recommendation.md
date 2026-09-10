# Current-observation pocket recommendation

`buildCustomCohortPocketRecommendation({ context_ref, retained_inputs, selection })`
is an internal diagnostic consumer of the existing owner-loaded retained capture.
`selection` is the saved checkpoint shape: `{ revision, included_recorded_group_ids }`.
It is not an HTTP endpoint, a supported-fact issuer or a report acceptance writer.
The caller still owns exact graph admission, organization/assignment authorization,
source-use permission, current-subject checks and response projection.

The actual optional catalog composer omits actionable recommendations when the
current-mirror capture was taken after the appraisal's effective UTC day.
Current observations/catalog inspection remain separate from historical report
evidence. The pure diagnostic kernel is unchanged; its current-observation
scores must not be presented as a retrospective recommendation. An earlier or
same-day capture is not proof of coverage, and the existing source-period and
report-readiness gates remain required. See the
[effective-date requirement](custom-neighborhood-supported-inputs.md#effective-date-requirement).

The kernel reuses the current-observation preview, recorded CAD group catalog and
existing neighborhood factor curves. Every unique discovered account remains
represented, including unknown/conflicting data and unassigned recorded groups.
It does not target 30 sales, choose a sample to improve COD, fabricate a geographic
boundary or treat a matching recorded subdivision label as legal identity.

## Initial review policy

The installed weights remain GLA40%, year-built similarity30%, housing type20%,
with site size, proximity and sale price each receiving one third of the remaining
10%. The current representation supports current GLA/year/site observations.
Housing taxonomy, comparable distances and sale consideration are explicitly
unavailable here; a one-unit land-use label is not treated as detached housing,
and CAD assessed values or source CurrentPrice do not stand in for sale prices.

Each property has a weighted similarity range. The lower bound sums only known
factor contributions; the upper bound adds the unobserved weight's maximum
possible contribution. Known-weight coverage is reported separately. These are
arithmetic bounds under this heuristic, **not confidence intervals, probabilities,
market eligibility or appraisal reliability**. No available-weight renormalization
hides the missing factors. A fully matched property with only GLA and year built
available has a 70–100 range and 70% known-weight coverage, not a 100% proven match.

Group means include every member, including members with no usable observations.
The initial suggested-for-review threshold is a mean lower bound of at least55
and mean known-weight coverage of at least70%. This is a starting review heuristic,
not an empirically validated guarantee. Groups rank deterministically by lower
bound, coverage, then ID. Member ranges and factor-state counts expose mixed groups.
Unassigned/incomplete recorded-name groups are not silently treated as recommended
neighborhoods. The subject's recorded group is separately identified for review;
its scores are not increased to force a match.

Subject values follow explicit saved physical inputs, then retained public subject
observations, then same-account current CAD observations only when the prior value
is absent. An explicit null, invalid edit, empty land list or ambiguous multiple
land rows does not silently fall through. Multiple land lines are not summed as
though they necessarily describe disjoint interests.
The same-node `total_living_area` alias is considered only when `living_area_sqft`
is absent. Explicit null/blank/invalid alias values still block older fallback;
`total_area_sqft` is not assumed to mean living area.

## Selection, performance and integration

The entire captured roster establishes one fixed scoring baseline. Including or
excluding a pocket changes selected-union summaries, not the underlying property
scores. Duplicate account membership is rejected. Explicit empty selection stays
empty; unknown group IDs are rejected. The original checkpoint intent is returned
unchanged, with recommendation IDs separate from it.

This pure function performs no source query, database write or network request.
Existing preview/catalog record/work limits apply, and output is bounded. Scores
and selected/all summaries can later be projected through the existing authorized
preview response. Browser integration must check the exact context and selection
binding, and use the existing serialized checkpoint action for an explicit
appraiser choice. It must not update accepted statistics separately from geography
or bypass the final coherent report-acceptance path.

This change alone does not activate the production workspace, add a button, alter
the current report, establish final statistics, or provide builder/HOA/phase data.
Those missing details remain unknown, not inferred from the pocket name.
