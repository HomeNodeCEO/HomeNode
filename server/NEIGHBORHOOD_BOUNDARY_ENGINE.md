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
- Broad descriptive boundary generation now uses the saved property-complexity
  profile to select a discovery radius, forms a simplified parcel-center hull,
  confirms that the subject remains inside it, and attaches local cardinal-road
  and official-zoning evidence. Request-time generation never requires a remote
  road or zoning service.
- Each generated result is stored in
  `app.neighborhood_boundary_assessments` with the assignment-file scope,
  methodology version, input signature, source state, confidence, warnings,
  geometry, and appraiser confirmation. Re-running unchanged evidence reuses
  the same auditable version; a changed source snapshot creates a new one.
- The Property Report can generate and apply a suggested boundary, populate the
  four editable road fields, and preserve the appraiser confirmation separately
  from source data. The report prints the boundary/relevance distinction.
- The relevant-property pass now scores up to 5,000 locally mirrored parcels
  inside that broad boundary. Same-use eligibility is a prerequisite; the
  remaining score is age 40%, site size 30%, proximity 20%, and unadjusted
  recent-sale price 10%. Missing sale prices do not create a penalty.
- A sub-20 score with at least 70% input coverage is excluded under the approved
  baseline. Other statistically dissimilar parcels are excluded only when at
  least three form a contiguous pocket within the saved parcel geometry. Every
  candidate, factor score, reason, point, and cluster is stored in normalized
  assessment/candidate tables for map display and calibration.
- A map overlay and Dallas County calibration remain the next phases.

## Boundary API

- `GET /api/accounts/:id/neighborhood-boundary` loads the latest result for an
  assignment file, falling back to the property-level result.
- `POST /api/accounts/:id/neighborhood-boundary/generate` generates and saves a
  result from local PostGIS mirrors. `assignment_file_id` and `search_profile`
  are optional; otherwise the saved complexity assessment chooses the profile.
- `PATCH /api/accounts/:id/neighborhood-boundary/:assessmentId` records or
  removes the appraisal-file confirmation without rewriting parcel, road, or
  zoning source data.
- `GET /api/accounts/:id/neighborhood-relevance` loads the latest saved
  relevance-population summary for an assignment file.
- `POST /api/accounts/:id/neighborhood-relevance/generate` scores and stores the
  parcel population tied to the latest boundary assessment.
