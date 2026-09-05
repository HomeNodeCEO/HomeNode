# UAD neighborhood review adapter (inactive)

This pure adapter maps an accepted `NeighborhoodAssessment v1` contract into one coherent Section 17 sales-review group. It adds no routes, database writes, workers, providers, feature flags, UI imports or export integration. The existing shared engine remains responsible for populations, measurements and spatial evidence.

Source: `server/src/modules/uad/neighborhoodReview.js`. Synthetic inputs: `server/test/fixtures/uadNeighborhoodReviewFixture.js`.

## Implemented mapping

The mapper version is `uad-neighborhood-market-v1`. It supports the repository-pinned release `uad-3.6-2026-08-13-h1.5` and hashes the exact catalog definitions it uses. A changed release requires a reviewed mapper update. These are existing canonical root fields; no new MISMO fields or UAD catalog definitions are introduced.

| Target | Source and condition |
| --- | --- |
| `market:3000.0008` | Explicit analysis-boundary narrative, maximum 1,250 characters |
| `market:3000.0010` | Explicit search criteria for the selected population/period, maximum 1,250 characters |
| `market:3000.0009` | Exact inclusive calendar-month lookback, integer 1–99 |
| `market_total_sales:3000.0026` | `transaction_count`, estimator `count`, integer 0–999 |
| `market_total_sales:3000.0028` | `recorded_sale_price`, exact type-7 quantile at 0 |
| `market_total_sales:3000.0029` | `recorded_sale_price`, exact median |
| `market_total_sales:3000.0027` | `recorded_sale_price`, exact type-7 quantile at 1 |

All four statistics must identify one complete canonical-transaction population of closed, single-property sales. Multi-property transactions, allocated prices, unique-property counts, assessed values, arbitrary quantiles and predominant values are not interchangeable with these targets. Every selected statistic must be required by the shared group; every required statistic must be mapped. The adapter never expands or prunes the immutable assessment dependency set.

Positive sales require complete price observations and all three strictly positive price companions in ascending order. With one sale all three prices must equal; with two sales the median must equal `(lowest + highest) / 2` without rounding. These rules also apply during receipt replay and export validation. Known zero sales omit the price suggestions, while requiring explicit evidence that all three current price fields are empty. Missing membership/coverage is incomplete, not zero. Catalog overflow and overlong text block the whole candidate; values are never clamped, rounded or truncated to make them fit.

Active/pending listings, trends, supply, marketing time, land-use percentages and Section 18 development/HOA evidence remain explicit omissions. In particular, neither geographic land coverage nor competitive-population membership certifies report eligibility. `status: ready` means this limited candidate/plan is structurally eligible for review; it does not mean Section 17 is complete or the report passes GSE checks.

## Trusted input contract

Only `request` is client input. All other inputs must be assembled on the server after the existing organization, assignment, workfile and reviewer authorization checks. Hashes are change detectors, not authorization tokens. This module must not be mounted directly as a JSON-to-write endpoint.

`buildUadNeighborhoodCandidate({ assessment, target, market_context })` returns a frozen proposal with no selected suggestions, or an incomplete result with no suggestions. It rebuilds the assessment using the accepted shared contract and compares its evidence digest.

Candidate admission checks each complete emitted evidence-reference list against the shared 1,000-reference limit; separate population/source counts are not sufficient. It also rehearses construction of the complete next-revision receipt against the unchanged 1,500,000-byte canonical JSON and 2,000,000-byte PostgreSQL JSONB-text limits. This private capacity-only rehearsal uses synthetic all-new slots, never authoritative occupancy, permission or a committed receipt. Its plan/receipt is discarded. At the same candidate/revision, every mixed new/reused partition retains identical member content and is no larger than the all-new wrapper. Admission is conservative at an exact boundary; nothing is truncated or removed to fit. Neither a public flag nor extra caller input can disable these checks.

`target` is the existing shared UAD attachment target: exact scope (organization, case, subject snapshot, account), report registry UUID, UAD workfile UUID, attachment UUID/revision, effective date, cutoff, editor revision and specification release. The mapper computes `source_digest_sha256`, `mapped_manifest_sha256` and mapper version itself. Apply additionally requires a recognized mutable `status`, `signed_at: null` and `has_signatures: false`, resolved from trusted current state. Missing or contradictory signature state fails closed.

`market_context` is a versioned, immutable **server-resolved** description of the actual market study. Required fields are:

- `context_version: 1`, exact `assessment_digest_sha256`, and `population_ref: { id, revision, member_set_sha256 }`.
- `transaction_scope: "closed_single_property_sales"`, backed by the source/eligibility resolver.
- Exact `observation_period: { start_date, end_date, date_basis: "closing_date" }`, equal to the selected population and assessment period. The cutoff and period end equal the appraisal effective date for this mapper version.
- `lookback_months`, interpreted as inclusive whole calendar months: the start is one day after the period end, shifted back the declared months with end-of-month clamping. No days/30 approximation or wall-clock date is used. Other period conventions remain unsupported.
- `analysis_geometry: { role, revision, geometry_sha256, boundary_description }`. For `role: "geographic_neighborhood"`, revision and hash match the shared geographic manifest, and the narrative must equal `North: <north>; East: <east>; South: <south>; West: <west>.` from its cardinal summaries. For `role: "competitive_market"`, the trusted context identifies the separately retained analysis geometry. Its narrative must describe that actual population geography. The adapter does not prove the geometry from a hash or join disconnected pockets.
- `search_criteria`, `source_refs` (nonempty, unique, within the group's source closure), and `statistic_ids: { count, low, median, high }`. For verified zero sales, the three price IDs must be explicitly null.

The existing Foundation contract has no typed catalog-specific boundary/search-context resolver, active/pending status history discriminator, or current listing-price measurement. This implementation makes the first prerequisite explicit and tests it synthetically. A production resolver must validate the competitive-market geometry, actual query filters, source facts and transaction eligibility before offering this context. It must not derive them from whichever account-wide study happens to appear first.

## Apply and saved receipts

`prepareUadNeighborhoodApply({ assessment, target, market_context, existing_values, request, accepted_receipt })` regenerates the candidate from current trusted inputs and delegates atomic preparation to the existing `prepareNeighborhoodApplicationGroup` helper.

`existing_values` uses the shared preflight occupancy format: `{ target_key, target_exists, populated, value, provenance_digest? }`. It must explicitly resolve all seven target keys, including empty price fields in a zero-sale group. Empty means `populated: false, value: null`; a real zero or false is not an empty value. Occupancy and provenance must be loaded from canonical UAD values and trusted acceptance records, not accepted from a browser. Do not infer compatible provenance from matching text or an old source label.

The request contains `confirmed: true`, `preserve_existing: true`, the complete `selected_suggestion_ids`, `expected_revision`, `expected_candidate_digest_sha256` and `expected_binding_digest_sha256`. There is no partial neighborhood acceptance. Incompatible manual values, unresolved occupancy, stale source/target/specification identity or missing dependencies cause zero planned writes. Compatible reused members stay in the selected group. Exact receipt replay is allowed only at the receipt's accepted editor revision, with matching current values and provenance; it produces `already_applied` and no new writes. Any later edit blocks apply replay.

Preparation uses actual canonical occupancy and constructs/checks the complete actual wrapper before returning any new `ready` plan. Capacity failures return no writes or acceptance manifest. Replay instead checks the complete persisted wrapper and its original revision; it does not issue a hypothetical successor receipt, which could be larger at a revision-digit boundary. Source/reference/catalog/lifecycle/identity/occupancy checks remain mandatory on both paths. Receipt construction and historical export enforce both complete-wrapper size limits, including outer checksum bytes and PostgreSQL's expansion of numeric JSON tokens. These neighborhood bounds do not impose a size limit on unrelated whole-appraisal snapshots.

`buildUadNeighborhoodReceipt(candidate, plan, accepted_editor_revision)` permits exactly one revision increment, validates the prepared receipt by replay, and wraps the shared receipt with immutable review evidence. The attachment source digest includes the **entire displayed evidence**, including selected statistics, populations, source snapshots and geographic/context narratives. Altering that evidence and recalculating only the wrapper checksum cannot change the committed attachment identity.

The later persistence adapter must lock the workfile/current revision and signature state, resolve the exact authorized attachment, and write canonical values, provenance, one revision, receipt and audit event in one transaction. Receipt construction itself proves no commit. The current legacy completion writer's partial-skip behavior must not be used to apply this group.

## Export provenance

`projectUadNeighborhoodExport({ receipt, target, existing_values })` accepts only the persisted receipt and the **requested saved report revision**. It verifies target identity, receipt integrity and every retained field/provenance match. It can project a later signed revision if its saved values still match the receipt, retaining both the original accepted revision and the exported revision. A revision before acceptance is rejected. The caller must resolve the rows from that exact snapshot; current editor rows cannot stand in for historical snapshot rows.

The result supplies canonical field keys and internal provenance. It has no provider or latest-assessment input. Future XML/PDF/package integration must continue through existing snapshot, catalog, signature and artifact validation; this helper does not add internal evidence to MISMO XML or replace GSE validation. A newer research result cannot modify the receipt or its projected evidence.

## Next integration steps

1. Implement the authorized stored-context/attachment resolver and occupancy projection using Foundation-owned persistence; catalog release and current signature checks stay explicit.
2. Add a separate transaction path for the atomic group and persist its receipt with the UAD revision/audit. Coordinate existing route and auth file ownership first.
3. Extend the existing review panel with one group-level selection, new/reuse/conflict states, visible evidence/omissions and accurate `already_applied` messaging. Preserve unsaved-edit checks.
4. Include the saved receipt in revision-bound validation/artifact inputs, then run the disposable database and full report integration gates.

Local verification: `node --test --test-concurrency=2 test/uadNeighborhoodReview.test.js test/neighborhoodAssessmentContract.test.js test/neighborhoodAssessmentApplicationGroup.test.js test/uadMarket.test.js` from `server`. These tests use synthetic data and pure helpers; no service, database or provider connection is involved.
