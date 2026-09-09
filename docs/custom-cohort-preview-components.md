# Custom cohort preview display boundary

`CustomCohortParcelMap` and `CustomCohortStatistics` are controlled, observation-only components. They do not fetch appraisal data, write drafts/workfiles, run the legacy neighborhood engine, or authorize report Apply.

## Host contract

- Pass the controller's accepted `group` and its `freshness` to both components. Never derive map colors from a pending selection while keeping the old summary.
- Pass the checked pocket catalog for the same retained context and subject. The catalog's baseline memberships remain valid across selection revisions; a context mismatch does not mount a map.
- Map `onInspectPocket(id)` and optional `onInspectAccount(accountId)` callbacks only identify a clicked parcel's exact recorded group/account. The host owns the keyboard-accessible group list, selection changes, and separately bound group-inspection requests. Inspection must not implicitly include a group.
- `CustomCohortStatistics` accepts a summary-only `{binding, summary}` group for the independent inspector. Use `selectedOnly` to avoid an unrelated all-population column. Missing pocket results remain unavailable; another pocket's results are never substituted.
- Keep the entire observation workspace out of report printing. Its medians and captured groups are not supported appraisal conclusions.

## Geometry and rendering

The map preserves the admitted GeoJSON Polygon/MultiPolygon coordinates, including holes and disconnected parts. It draws no circle, hull, buffer, road-based boundary, or inferred subdivision outline. Recorded CAD labels identify groups; they are not evidence of legal subdivision boundaries or competitive eligibility.

Green/gray show included/excluded observations. Amber marks unresolved recorded grouping, with a green outline when included. Purple highlights the subject; gold outlines the inspected group. These are selection colors, not similarity/reliability scores.

Selection and inspection changes use MapLibre feature state without re-uploading unchanged geometry or resetting the camera. Context changes dispose the old map. Cached geometry refreshes replace source data and reset retained feature state. Drawing/error overlays hide the canvas until the matching render finishes; failures show no invented replacement area. Runtime and rendering waits are bounded, and there are no automatic data retries.

The small runtime loader shares the existing MapLibre 5.12.0 URLs and `data-homenode-map-script/style="maplibre"` DOM keys. It neither loads a second library version nor imports the legacy analysis component.

## Numerical presentation

Statistics use the server formatter's display strings. Current CAD stock, canonical recorded transactions, and source-reported records remain separate populations. No client price/currency conversion, median/COD recalculation, thirty-sale cap, missing-to-zero substitution, predominant-value claim, or reliability score is introduced. Recorded transaction totals may be package prices, not individual-property sales prices.

## Verification

Focused frontend tests cover shared runtime reuse/timeouts; exact Polygon/MultiPolygon preservation; callback-only inspection; stale/empty selections; context changes; unmount/late-load cleanup; map errors; and actual v2 cached mappings → observation calculator → summary formatter → rendered distributions. The producer fixtures are synthetic representation tests, not proof of live provider coverage, report support, or browser basemap availability. Host/browser integration remains a separate acceptance step.
