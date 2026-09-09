# Custom cohort assessment preparation: diagnostic only

`server/src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js`
exports `prepareCustomCohortAssessmentPreparation`. This is **not an assessment
assembler**, a supported-fact issuer, an HTTP endpoint, or an Apply bridge.

```js
prepareCustomCohortAssessmentPreparation({
  context_header_json, // canonical exact retained context header
  expected: { context_ref, target, observation_period },
  retained_inputs, // loadCustomCohortCaptureInputs(...).retained_inputs
  selection: { revision, included_recorded_group_ids }, // saved workspace intent
});
```

`target` is the existing exact context scope: `organization_id`, `report_file_id`,
`assignment_file_id`, `account_id`. The function checks the existing context and
checkpoint contracts, rebuilds all four capture dependency references, checks
the capture operation, subject snapshot/version, effective date and exact study
period, then resolves group IDs using the actual retained recorded-label catalog.
Unknown IDs fail; explicit `[]` remains empty. Missing county/name evidence can
be selected only through the explicit existing `discovery:unassigned` group.

The result is always `status: 'incomplete'`, with `assessment: null`,
`publication: null` and blocked Apply. It contains exact binding, observation
counts, existing preview support gaps and unavailable-metric reasons. It returns
no raw records, member arrays, prices, recomputed report statistics or boundary.
`selected_account_set_sha256` uses the existing repository's sorted member-ID
digest; it is **not** the preview's pocket/revision fingerprint or proof of truth.
Transaction counts use stored canonical closing dates; source-record counts
include all retained dates. Whole package transactions are counted once when
associated with selection, never allocated to each parcel.

The bounded descriptor walk does not invoke accessors/proxies or stringify/copy
the entire retained graph. Existing capture, preview and catalog limits remain
in force; exceeding any bound fails the whole call, without sampling. The new
outer limits are 2 million visited nodes, depth 40, 192 MB of logical input
string bytes and 32 KiB output. This pure preparation still does real validation
work; it is not a cache or permission to run an unbounded HTTP request.

## What still prevents a supported assessment

| Needed resolver input | What the actual retained CAD/sales capture establishes instead |
| --- | --- |
| Dated housing classification and physical facts with evidence applicability | `cachedRowMappings.js` version 2 preserves current CAD/MLS observations; a year-built value or current land-use label does not certify housing/condition at the appraisal or sale date. |
| Completed event, date, actual consideration/currency and interest scope | A canonical sale row and recorded price are preserved, but `closed_sale` and a non-null amount do not prove completion, consideration meaning, currency or market eligibility. |
| Complete economic-property membership and cross-source transaction equivalence | Captured parcel associations/closure preserve recorded links, including linked-only accounts and packages; they do not prove complete interests, equivalence or defensible price/GLA allocation. |
| Explicit competitive housing policy and reviewed material conditions | Recorded group names and appraiser inclusion intent identify the chosen account set, not an eligibility finding. |
| Supported geography and appraiser-reviewed boundaries | The discovery roster and recorded subdivision names are not a legal subdivision, road boundary or cardinal description. |
| Supported estimator/source coverage | Median is not predominant; COD is dispersion, not reliability; current snapshots do not by themselves prove market trends, historical tax year or complete real-world coverage. |

`cohortDecisionCommand.js::prepareCohortDecisionCommandV1` already specifies
evidence-linked claims for completion, date, consideration, membership,
equivalence, housing-at-date, completed-home status, material conditions and
study review. It admits a command structure, not current issuer authority.
The missing next service is an owner-controlled, exact-context decision/evidence
resolver with conflict/unknown handling and retained provenance—not a bag of
client `verified` or `eligible` booleans. Until that exists, this diagnostic
does not fabricate a synthetic supported assessment, even for apparently
complete numeric source records.

Once facts really are supported, reuse `cachedRecords.js::buildCachedNeighborhoodInputs`,
`statistics.js::summarizeNeighborhoodPopulations`, `contract.js::buildNeighborhoodAssessment`
and `assessmentRepository.js::prepareNeighborhoodPublication` with full retained
member/source evidence. Existing ranking is not enabled by this diagnostic.
Existing Custom report mapping/acceptance must continue to apply geography,
selection, populations, statistics and evidence as one coherent validated group;
`customAcceptanceSave.js::saveCustomNeighborhoodAcceptanceInTransaction` is not
called here, and no accepted report fields are overwritten.

## Rights activation is separate from factual support

The runtime owner must independently authorize the exact organization/assignment,
reopen the exact context and check subject freshness. The integrated-source
policy in `server/src/security/customNeighborhoodSourcePolicy.js` requires genuine
owner-established dataset/provider rights, retention and exposure coverage;
see [source-rights policy](custom-neighborhood-source-rights-policy.md).
This diagnostic performs none of those permission checks and says `not_checked`.
Activating a rights grant allows a permitted use; it cannot make current CAD
facts historical, certify a sale, establish eligibility or turn this result
ready. Conversely, correct evidence does not supply permission to expose it.

Focused tests use actual subject/spatial/source capture, persisted blob graph
and reopen APIs over bounded query fakes, not native PostgreSQL or live source
rights. They cover empty/changed selections, multi-page retention, packages,
wrong targets/periods/dependency hashes, malformed data and caller authority
claims. No production activation or complete assessment generation is claimed.
