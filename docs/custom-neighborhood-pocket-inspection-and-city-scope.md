# Custom neighborhood inspection and wider discovery

User-approved extension, September 7, 2026. This adds to the existing coherent
cohort workflow; it does not replace the fixed three-mile simple-suburban default.

## Pocket inspection slice

Clicking a mapped pocket opens an inspector without changing membership. The
keyboard-accessible pocket list exposes the same inspector. Explicit Add/Remove
Pocket controls use the existing selection/statistics/save path, and the inspector
displays the current overall reliability, COD, and sale count. Removal is analysis
exclusion, never deletion of a CAD account or sale. Closing and Escape preserve
membership. A changed assignment or source assessment invalidates the open details.

The inspector describes all supplied mapped parcels in that pocket, even if the
pocket is excluded. It displays recorded subdivisions and CAD land-use categories,
GLA, year built, age at the assessment date, site size, CAD market values, observed
sale prices, price per square foot, and days on market. Missing data is counted;
zero DOM and a newly built home's zero age remain valid. CAD values are not sale
prices; descriptive medians are not concluded predominant values. Monthly price
observations are not an appreciation model. The panel is read-only except for
explicit membership controls and paginates property rows to avoid rendering an
entire city's properties into the DOM.

Existing cached assessments may lack the newly exposed subdivision, land-use,
and DOM fields. Show unknown until refreshed; never borrow report-wide or subject
values for every property. Additional normalized evidence is still required for
original builder, HOA fee ranges/frequency, amenities and access rights, zoning
classification/overlays, and verified housing types (distinct from CAD land use).

## Required wider-area implementation (not complete in this slice)

- Add a city-boundary **view** separately from a citywide **analysis** scope.
  Zooming/panning or showing a city outline must not mutate the report's cohort.
- Use authoritative municipal geometry with jurisdiction ID, source URL, vintage,
  retrieved time and content digest. Cache the last validated geometry; a provider
  outage must report stale/unavailable evidence without erasing the cache.
- Candidate starting source: U.S. Census TIGERweb Incorporated Places, January 1,
  2026 vintage: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4
  This is a dated statistical boundary reference, not proof of current annexation
  or legal zoning. Do not dissolve zoning polygons or use mailing-city strings as
  municipal boundaries. Verify official city changes where relevant.
- Keep the three-mile input profile fixed. Citywide discovery requires a distinct,
  versioned input profile containing the exact cached municipal geometry identity;
  do not silently increase radius or treat a city's bounding box as its territory.
- Gather complete, authorized property and transaction evidence for the requested
  scope, including cross-county portions. No first-30-sales target or silent record
  cap. Explicitly report incomplete geographic/MLS coverage and unsupported limits.
- Recompute similarity relative to the subject/subdivision throughout the wider
  scope, then allow pocket inspection/inclusion/exclusion and show the resulting
  reliability, COD, sample coverage, and population/sales comparison together.
- Capture scope + pocket membership + criteria + statistics as one coherent saved
  group. Expand/cancel/error/reopen and stale-response races must not combine new
  boundaries with old statistics. Wider discovery does not overwrite an appraiser's
  rough report boundary without an explicit action.
- Per-property edits inside a pocket require explicit persisted membership and
  provenance; the initial inspector intentionally exposes whole-pocket controls.

## Acceptance queue

Hardy, Snowmass, and Aaron: inspect before changing, Add/Remove with live metrics,
Escape/focus return, mixed subdivisions/uses, unavailable builder/HOA/zoning,
zero/missing DOM, all transaction records in period, USD formatting, narrow screens,
large paginated lists, changed assignment/assessment, save/reopen and signed-file
restrictions. City slice adds outside-radius pockets, cross-county cities, polygon
holes/multipart geometry, source outage with retained cache, incomplete coverage,
expanded-scope cancellation, and performance measurement before production.
