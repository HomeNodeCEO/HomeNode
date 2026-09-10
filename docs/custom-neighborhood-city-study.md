# Custom neighborhood city-shaped analytical discovery

## Appraiser workflow

The **Analytical study area** chooser offers the existing 3/5/10-mile searches and dated installed city polygons for Coppell, Dallas, Duncanville, Garland and Irving. Changing the chooser alone does not fetch data or alter the displayed study. Start the next capture explicitly; the previous coherent study remains available until the replacement succeeds.

City acquisition intersects the complete cached parcel geometry with the selected polygon. It does not use mailing-city text, the map viewport, a bounding rectangle, a centroid, a target sale count or an inferred neighborhood boundary. Holes and disconnected parts are honored; a parcel touching or crossing a city edge is included whole. The subject must already belong to the selected roster; an outside subject is refused, never appended.

The original recorded CAD groups become inspectable pockets. Their complete eligible sales and stock observations feed the existing selection/statistics workflow. Recommendations for city scope use the recorded-housing policy without radius-calibrated proximity. Unknown evidence retains its weight as unknown. A similarity score is not a reliability guarantee or a reason to maximize a score by hiding inconvenient sales.

The separate **Show city limits** map control remains reference-only. The appraiser's rough report outline remains independently drawn and reviewed. Neither city acquisition nor switching pockets overwrites an accepted report: boundary and statistics still apply as the existing coherent five-part group.

## Closed identity and replay

The optional capture `discovery` is:

```json
{
  "profile_id": "custom-city-polygon-v1",
  "city": {
    "geoid": "4819000",
    "vintage": "2026-01-01",
    "asset_sha256": "0c30be3e248c4353d757730715c9b86aae10b268268a243bd7e4957ea21e6c4d"
  }
}
```

This is the installed Dallas identity, not a production assignment or authorization. The digest binds the full original Feature UTF-8 bytes. New capture loads only the local fixed server registry; clients cannot send geometry, a source URL, an alternate file path or source rights. The original provenance is retained unchanged, including its original map-reference purpose. The versioned computational intersection is a separate choice, not a new claim of authoritative/current municipal applicability.

Selector input version 3 binds the original subject Point, exact city identity and `postgis_geometry_intersects_city_v1` predicate. The existing immutable graph stores original city bytes/provenance once in spatial metadata. Replay rebuilds and verifies that graph before consulting any present-day registry; a registry refresh cannot silently redraw a saved study. Transaction/source closure remains account-based and includes required co-parcel associations outside the geographic stock roster.

City capture echoes the choice plus `parcel_count` and `account_count`; there is no radius. The outer catalog response carries the same `discovery` identity without changing the inner catalog. The frontend rejects a missing/mismatched city or a contradictory radius-based recommendation.

Checkpoint version 4 retains city or radius intent. If a city study is active while a radius replacement is pending, the checkpoint stays version 4 until replacement succeeds. Explicit empty selections, retries, uncertain saves, read-only/signing barriers and same-operation conflicts retain their existing behavior. Legacy versions 1/2/3, omitted default discovery and existing radius digest fixtures are unchanged.

## Capacity, history and coverage

No limit is raised. The existing spatial, source-reader, retained-graph, catalog, map and overall owner ceilings in [discovery expansion](custom-neighborhood-discovery-expansion.md#capacity-and-coverage) still apply. A large city can exceed these bounds; failure must be explicit, with no successful-looking truncated population. A complete cached query does not prove complete provider coverage. This release does not promise that the entire Dallas inventory fits the synchronous workspace.

The 2026 city snapshot is not historical housing-stock evidence. A retrospective assignment still needs source evidence from its effective period; later CAD observations cannot become historical stock merely because old sale dates are available. CSV and future Trestle records continue through the same existing source, review and authorization boundaries. No retention purge, provider download, database migration, role change or production activation is introduced here.

## Verification and remaining acceptance

Tests cover fixed original asset bytes, malformed/changed identities, radius parity, retained graph/source closure, mixed-version save/reopen, historical omission, authorization denial, real PostGIS holes/islands/touches/crossings, complete capacity refusal, and actual atomic report Apply/recovery. The three native integration wrappers are registered in the existing migration CI suite.

Local verification: 6,910 server tests passed (31 external/database cases skipped by the ordinary suite), 2,205 frontend tests passed, and TypeScript, lint/source budgets, production build and bundle budgets passed. Separate actual PostgreSQL/PostGIS runs passed 39 existing coordinator checks, 8 city-owner checks, 5 polygon-membership checks and 11 atomic report-Apply checks. These synthetic checks do not establish production coverage or live-file acceptance.

TODO(neighborhood-acceptance): Exercise Snowmass, Duncanville, Coppell, Irving and Dallas in the signed-in application against installed source permissions and measured cache sizes. Confirm practical capture/catalog/map capacity and effective-date coverage before advertising complete citywide analysis. Builder/HOA/amenity evidence and legally sourced subdivision/phase extents remain separate from recorded CAD pocket labels.
