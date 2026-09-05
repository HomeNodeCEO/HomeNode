# Cached linework preparation v2

`server/src/services/neighborhoodAssessment/graphPreparation.js` validates an exact, bounded road capture for later geometry processing. It is not an authorized spatial reader, report boundary, travel graph or proof of provider coverage. No route, provider, job or report consumer is activated here.

## Closed source inventory

Input version2 requires `capture.source_inventory`, an explicit bounded list of `{source_layer, source_key}` bindings. Every requested query layer needs at least one binding; every binding needs a current source state and its matching completed latest run. Every returned feature must match a declared layer/source pair and a completed originating run. An unchanged feature from an earlier completed incremental run remains valid evidence.

A requested layer with zero returned features is supported only when its source inventory/state/latest-run evidence is present and complete. An omitted feed cannot be inferred empty from the total feature count. Layer labels do not implicitly name source keys. Duplicate bindings are invalid; unknown/unrequested/mismatched sources make the entire handoff incomplete. Normalized bindings are included in the immutable capture digest. This complements, and does not replace, the trusted reader's raw timestamp, count and source-registry checks.

## Separate normalization and retained-output budgets

The existing eight-million-byte aggregate ceiling applies to normalized retained rows and the final serialized handoff. Each expanded line-part row, including identity, order, geometry and hashes, is charged before copying its coordinates. Final feature descriptors are charged after their hashes are populated. Single-feature canonical encoding remains independently bounded.

`counts.normalized_bytes` records bounded normalization work, including at most the first overflowing row. `counts.retained_bytes` is the exact UTF-8 size of the returned JSON object, including array delimiters, metadata, diagnostics and the count itself. Rows are measured incrementally rather than constructing a second aggregate JSON string. Consequently an atomic incomplete response is small even if normalization rejected a large input.

Any incomplete result has no partial feature/line-part/alias prefix or usable capture/content hash. Expanded-output overflow also omits bulky source metadata and sets `metadata_not_returned`. The version change is intentional; earlier unactivated v1 preparation did not require a closed layer inventory and did not measure expanded output correctly.

## Evidence and follow-up

The focused tests include distinct layer/source labels, complete-empty and omitted feeds, mismatched latest runs, deterministic binding order, and a raw input below8MB whose multipart/hash expansion exceeds the limit. These are pure fixture checks, not native geometry or live-feed validation.

Source-backed noding, actual polygonization, geometry validity, metric bounds, connected cell selection, geographic/competitive-population separation, durable publication and guarded report application remain separate steps. A `ready_for_preprocessing` result must never be labeled report-ready.
