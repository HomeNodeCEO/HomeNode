# Custom neighborhood map references

The Custom workspace keeps the captured parcel selection and its statistics as one coherent controller group. This view-only layer adds clearer interpretation without creating a second analysis or changing inclusion.

## Parcel colors and recorded labels

- Included/excluded coloring remains the default. Optional **Pocket similarity** uses the already checked recommendation's recorded-group mean lower bound, on the original 0–100 scale. It does not recompute scores, renormalize unknown weights, or label an individual parcel with an individual-property score.
- Fixed bins are 75–100 (green), 50–<75 (lime), 25–<50 (gold), and 0–<25 (orange). Missing/insufficient observations and unresolved recorded groups are gray. The original lower/upper bounds and known-weight coverage remain unchanged in the catalog and inspector.
- Excluded parcels remain faint. Subject, inspected group, included, excluded, and unresolved outlines retain their selection meanings. Similarity is not reliability, representativeness, or appraisal eligibility.
- Optional subdivision labels copy the exact retained CAD group name. A phase is displayed only if it is actually in that name. One deterministic label anchor is selected from an existing exterior parcel-ring vertex, with exact account/parcel identities. No hull, centroid, repaired polygon, or legal subdivision boundary is invented. Holes and disconnected parcel parts remain unchanged.
- Clicking a current label opens that group, not an underlying neighboring parcel. Label overlap arbitration is independent of listener order. Hidden/foreign labels cannot intercept parcel inspection. Keyboard group controls remain available.
- Visual changes update feature state or the separate label source without recreating the map, fetching a cohort, changing selection, or forcing the camera back to the subject. Only a new coherent geometry/selection result requires the matching-draw barrier.
- The parcel source explicitly promotes each exact opaque parcel ID into runtime feature identity. Browser QA caught and corrected an otherwise silent failure where the legend changed but string-ID feature-state colors stayed unchanged after GeoJSON tiling. No array-index or account-level replacement identity is used.

## Saved city limits

The manual city chooser restores the previously verified Census incorporated-place snapshots for Coppell, Dallas, Duncanville, Garland, and Irving. These snapshots are dated **January 1, 2026**, and are not a claim about current annexations or the subject's jurisdiction. Provenance, recorded byte counts and SHA-256 hashes are retained in `dcad-frontend/src/data/neighborhoodCityBoundaries.json`.

The browser requests only a fixed same-application static asset after **Show city limits**. Each response has a ten-second timeout, bounded streaming, exact size and SHA-256 validation, identity checks, and bounded Polygon/MultiPolygon decoding. Redirects are refused and credentials omitted. No GIS-provider call occurs when the saved outline is displayed. Failed loads can be retried; stale loads cannot update a new/disposed map.

Showing city limits saves the current camera once, draws the actual saved boundary, and fits that reference. Switching cities retains the original camera. **Return to analysis area** clears only the reference and restores the exact original center, zoom, bearing and pitch. Accepted selection refreshes do not recenter while a city reference is active.

**This is not citywide parcel/sales acquisition.** The captured discovery radius, data coverage, drawn report boundary, selected group membership, observations, checkpoints and accepted report group remain unchanged. The chooser does not infer jurisdiction from a mailing address. A later citywide capture needs its own versioned source, geographic scope and complete coverage checks; zooming out must never silently expand the population.

## Scope and verification

No API, schema, source-grant, authentication, signing, calculation, report/PDF mapping or production flag changes are part of this slice. Unknown builder, HOA, amenities and phase evidence remain unknown.

Tests cover exact saved asset hashes/holes/disconnected parts; catalog/context/geometry identity; unchanged existing scores and explicit unknowns; stable original-vertex labels; map lifecycle, overlapping clicks and hidden labels; feature-state-only recoloring; city camera retention and stale callbacks; and unchanged statistics/selection writer callbacks. The real local browser harness additionally exercises the mounted workspace against an existing saved synthetic assignment without exposing capture or report-write routes.

TODO(neighborhood-acceptance): Repeat visual review on Snowmass, Duncanville, Coppell, Irving and Dallas subjects with distinct subdivision phases and fragmented parcels. Validate retained CAD names against source evidence; do not convert recorded-label grouping into a legal subdivision extent. Citywide acquisition and calibrated reliability remain separate work.
