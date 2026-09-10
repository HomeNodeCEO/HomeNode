# Custom neighborhood discovery expansion

The radius behavior below remains supported. The subsequent [city-study extension](custom-neighborhood-city-study.md) adds a separate explicit polygon choice and checkpoint version 4; the dropdown is now labelled **Analytical study area**.

## Implemented behavior

The Custom saved neighborhood workspace supports three-, five- and ten-mile analytical discovery. Changing **Study radius** changes only the next capture choice. It does not fetch a new roster, alter the displayed study, select pockets or apply report values until the appraiser explicitly starts a capture.

The displayed study is labelled separately from the next capture choice. A successful capture saves its exact context, period, radius and selected recorded-group IDs. Reopening uses that saved context; it does not reconstruct the radius from the current dropdown or today's source data. Explicit empty pocket selection remains empty.

The radius measures spheroid distance from the original retained subject point to each cached parcel geometry, using `ST_DWithin`. The complete set of intersecting cached parcels is considered within the installed capacity bounds. This is not a centroid-only search, a clipped parcel shape, an inferred subdivision boundary or a target number of comparable sales. There is no top-30 sales rule. Transaction/source observations retain their existing observation-period and complete-account-association rules.

## Capture API and installed profile

`POST /api/accounts/:id/neighborhood-cohort/capture` retains the existing authenticated assignment, operation and period fields. The optional `discovery` object is closed and accepts only:

```json
{
  "profile_id": "custom-suburban-radius-v2",
  "radius_metres": "8046.72"
}
```

| Choice | Exact `radius_metres` string |
| --- | --- |
| 3 miles | `4828.032` |
| 5 miles | `8046.72` |
| 10 miles | `16093.44` |

For example, the request body for a five-mile study is:

```json
{
  "assignment_file_id": "37",
  "operation_id": "10000000-0000-4000-8000-000000000001",
  "observation_period": {
    "start_date": "2026-01-01",
    "end_date": "2026-09-10"
  },
  "discovery": {
    "profile_id": "custom-suburban-radius-v2",
    "radius_metres": "8046.72"
  }
}
```

These IDs and dates illustrate the grammar, not a production target. The owner resolves the actual assignment and retained effective date. The observation period must satisfy the existing date checks.

`private_sales_import: {batch_id, expected_review_revision}` remains independently optional. A reviewed private CSV capture uses the deliberately chosen radius and the exact saved source review revision; it does not revert to three miles or substitute the latest review. Private sales remain supplemental to the shared cached-source capture, not a new bypass mode.

The registered response retains `discovery: {radius_metres, parcel_count, account_count}`. Both the frontend API and lifecycle check the radius against the detached request before activating a context. Missing, numeric, unknown or mismatched response radii are not defaulted.

## Checkpoint and immutable compatibility

The `neighborhood_workspace` editor section now admits `workspace_version: 3`:

- A non-null `pending_capture` requires `operation_id`, `observation_period` and the exact `discovery` choice. It may also contain `private_sales_import`.
- A non-null `active` retains its existing `context_ref`, `observation_period` and `selection`. It may contain `discovery`; newly activated expanded-profile contexts do contain it. Absence remains valid for a legacy active study while an expanded capture is pending.
- Reusing the same context/operation ID requires identical period and discovery. Omitted legacy discovery and explicit v2 three-mile discovery are distinct identities.

The lifecycle durably saves pending intent before capture. It preserves the same operation UUID, discovery and optional private-source reference through explicit retry, lost acknowledgements and reload. An expanded active study requires an explicit discovery choice for another capture; it cannot silently downgrade to a legacy request. The host supplies that choice, including explicit v2 three miles when appropriate.

Requests without `discovery` continue using `custom-simple-suburban-radius-v1` and exactly `4828.032` metres. Existing checkpoint versions 1 and 2 still reject discovery fields. Their output shapes and legacy selector/spatial digest paths remain unchanged. Old captures reopen their original retained roster rather than adding newly cached parcels. V2 radius choices have a separate selector version and spatial-membership digest domain, even when the chosen radius is three miles.

Source mapping versions 2/3/4 and the `local-capture-v3` reader envelope are separate concerns and are not changed by choosing a larger radius. Existing immutable context/blob storage is reused; no new source license or report authority is inferred from a profile name or hash.

## Capacity and coverage

The expansion does not raise the installed limits:

| Stage | Existing limits |
| --- | --- |
| Spatial membership | 50,000 accounts; 100,000 parcels; 16,777,216 bytes; 15 seconds |
| Transaction closure | 100,000 identity records; 8,000,000 bytes |
| Cached source reader | 100,000 total records; 30,000,000 bytes; 64,000 bytes per row; 30 seconds |
| Retained input graph | 192,000,000 logical bytes; 4,000 blobs; 12,000 references; 1,500,000 bytes per blob |
| Recorded pocket catalog | 128 named groups; 4,000,000-byte public transport envelope |
| Parcel map | 250,000 coordinates; 16,000,000 geometry/GeoJSON bytes |
| Overall capture owner | 60 seconds |

These are admission ceilings, not measured performance guarantees. Parcel, account, identity, source and association data consume downstream budgets; a radius does not guarantee that a dense area will fit. Membership/source limit failures do not publish a clipped successful roster. Catalog overflow can preserve the entire captured roster as explicitly unresolved membership, without an arbitrary prefix of named pockets or actionable recommendations. Map capacity failure is reported as unavailable rather than fabricated geometry.

Complete cached-query membership is **not provider completeness**, citywide market coverage, historical stock evidence, competitive eligibility or reliability. Existing source-policy retention/exposure checks and final authorization checks remain in force. Current CAD observations remain current observations. Larger radius and old CSV sale dates do not bypass the retrospective-stock guard or turn a later mirror into evidence of the past neighborhood.

If a new capture fails, the prior active checkpoint and last coherent displayed map/statistics are retained; the failed or uncertain pending intent stays explicit for recovery or **Set aside pending capture**. Setting it aside clears only the pending choice, not immutable source evidence or an accepted report. The existing report remains unchanged until an explicit coherent whole-group Apply or replacement succeeds.

## City reference is still separate

The installed January 2026 Census incorporated-place outlines are dated map references. Showing a city, switching references or returning the camera does not change the analytical capture. This change does not implement municipality-shaped discovery, mailing-city selection or unrestricted citywide analysis. A ten-mile radius is not a city boundary, and a municipal outline is not proof that all of its parcels or sales are present in the cached sources.

## Verification at this checkpoint

- 52 new frontend discovery tests passed, including actual frontend/server checkpoint parity, all three radii, private CSV combination, malformed input, detached asynchronous inputs, response mismatch, exact retry/reload and preserved empty selection.
- 256 combined frontend checkpoint/lifecycle/API tests passed; this total includes the 52 new tests.
- 33 host tests passed, including radius intent without automatic capture, retained prior display after failure and private CSV radius propagation.
- The server checkpoint owner reported 111 combined checkpoint/persistence tests passed, including legacy hash fixtures and the existing writer's CAS/read-only guards. These overlapping suites are not additive platform totals.
- TypeScript `--noEmit` and affected-file lint passed.

- Full frontend suite: 2,020 passed; full server suite: 6,593 passed, 26 skipped, zero failures. Native PostgreSQL checks below execute the relevant database cases separately; skipped external-integration tests are not claimed as passed.
- TypeScript, lint/source budgets, production build and bundle budgets passed (236 KiB initial JavaScript; 99 KiB CSS).
- Actual isolated PostgreSQL/PostGIS test passed: a four-mile parcel appears only in the five-/ten-mile studies, and an eight-mile parcel only in the ten-mile study. Retained graphs, replay/conflict checks, preview member counts and source-authorization refusal also passed. The test creates a separate synthetic draft; earlier signed fixtures are not reset or unprotected.
- A separate current-date native database test passed five-mile capture, proposal, atomic five-part Apply, lost-commit-acknowledgment recovery and fresh accepted reopen. Its actual four-mile parcel remains included in the saved counts and characteristics. Changing the saved radius without changing the retained context is rejected before either proposal or Apply writes.

Browser verification and protected remote CI remain separate release gates. These local results do not claim production activation, live source coverage, or deployment.
