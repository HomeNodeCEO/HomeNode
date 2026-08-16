# Neighborhood boundary and relevance engine

## Separate appraisal questions

HomeNode must preserve two independent conclusions:

1. The **descriptive neighborhood boundary** is a broad geographic description
   supported by road and zoning patterns.
2. The **relevant property dataset** is a statistically screened population for
   the subject. A parcel may fall inside the descriptive boundary and still be
   excluded from a particular analysis because its characteristics are not
   relevant to that subject.

Neither result automatically replaces the appraiser's final judgment. The
application should minimize review by presenting a default recommendation,
confidence result, concise exceptions, and the evidence needed to confirm it.

## Relevance methodology version 1

The initial scoring weights are:

- Age / year built: 40%
- Site size: 30%
- Proximity: 20%
- Unadjusted sale-price similarity: 10%

Gross living area is a diagnostic with a deliberately wider tolerance and does
not contribute to the version 1 score. Sale prices are not time-adjusted. The
market-conditions analysis may describe appreciation or decline separately,
but it must not alter the recorded sale price used by this methodology.

The initial exclusion threshold is a relevance score below 20%. A candidate is
only auto-excluded by this threshold when at least 70% of the weighted inputs
are available. A low-information record remains visible as `insufficient_data`
instead of being excluded merely because important fields are missing. The
threshold is versioned and deliberately configurable for later calibration.

Candidate distributions use 5th/95th-percentile winsorization before standard
deviations are calculated. Minimum effective standard deviations prevent
statistically uniform subdivisions from being fragmented by immaterial
differences.

An individual parcel is never automatically removed merely because it is an
outlier. It becomes a potential dissimilar-cluster member when at least two of
age, site size, and sale price are 1.5 or more standard deviations from the
subject reference, or when one factor exceeds 2.5 standard deviations and is
supported by a strong road or zoning transition. A later spatial pass must find
a contiguous cluster before excluding a pocket.

Missing sale data does not make a parcel dissimilar. Scores normalize across
available factors, while the separate confidence assessment records missing
coverage and determines whether automatic expansion or appraiser review is
needed.

## Boundary disclosure

> Neighborhood boundaries describe the subject's broader geographic setting
> and are not treated as an automatic inclusion rule. Properties within the
> stated boundaries are independently screened for relevance using age, site
> size, proximity, and unadjusted sale-price similarity. Dissimilar pockets may
> be excluded from the analyzed dataset, while gross living area is retained as
> a secondary diagnostic with a wider tolerance. Roadway and zoning patterns
> support, but do not independently determine, the relevant market area.

## Planned implementation order

1. Measure county parcel, physical-characteristic, coordinate, sale, road,
   traffic, and zoning coverage.
2. Move boundary-road identification to the local PostGIS road mirror.
3. Generate the broad descriptive boundary.
4. Form contiguous parcel clusters and apply the relevance methodology.
5. Persist both outputs with source versions and confidence evidence.
6. Add the map, report explanation, and exception-focused appraiser review.
7. Calibrate thresholds against appraiser-reviewed Dallas County subjects.

## Current foundation

- The version 1 relevance calculation and confidence safeguards are implemented
  as a side-effect-free service with automated tests.
- A local-only Dallas County readiness audit measures the parcel, physical
  characteristic, coordinate, sale, road, traffic, zoning, and source-health
  coverage required before low-review automation is enabled.
- Cardinal boundary-road descriptions now read the synchronized PostGIS road
  mirror first. TIGERweb remains a temporary fallback only when the local mirror
  has no usable boundary roads.
- Broad boundary generation, contiguous-pocket classification, persistence,
  map/report review, and Dallas County calibration remain subsequent phases.
