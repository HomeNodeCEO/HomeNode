# Custom neighborhood integrated-source rights policy

`server/src/security/customNeighborhoodSourcePolicy.js` supplies the existing
coordinator's independent market-data callback. It does not mount routes, grant
an organization access, provision metadata, change authentication or certify
source completeness, housing classification, historical support or eligibility.

```js
const authorizeMarketData = createCustomNeighborhoodSourcePolicy({
  datasetRevision, // trusted, independently maintained integrated inventory revision
  providerRevisions, // [{ provider_id, revision }], exact approved source/terms revisions
});
// Existing coordinator calls:
await authorizeMarketData(boundedClient, auth, context, purpose, {
  retention: true,
  exposure: 'none', // or report_observation_summary / members / catalog (full names below)
});
```

The factory profile comes from trusted server composition, never a request or
the same organization metadata being checked. Missing profile entries reject
construction. All subsequent calls query only the exact organization's rights
namespace and active flag using the caller's bounded client. No pool, connection
lifecycle, grant cache, remote provider, source read or metadata write is used.
Assignment/workflow authentication and authorization remain the coordinator's
job; an application role, username, professional license or successful import
is not a source-data grant. The callback also requires an actor and Custom target.

## One-time owner-provisioned metadata contract

An authorized operator must obtain and record the actual source-rights owner's
basis before setting `app_auth.organizations.metadata.custom_neighborhood_source_rights`.
This is a closed version-1 object; missing, unknown, malformed, expired or revoked
fields deny. This document contains no usable production grant or provisioning SQL.

| Required field | Exact value or owner-supplied information |
| --- | --- |
| `policy_version` / `purpose_version` | Both `1` |
| `organization_id` | Exact lowercase UUID of the organization row and authorized context |
| `grant_id` | Stable owner-approved grant identifier, at most 80 characters |
| `dataset.id` | `integrated_cached_market_dataset` |
| `dataset.revision` | Exact independently maintained trusted `datasetRevision` |
| `dataset.coverage` | `entire_integrated_source_mix_including_prior_merged_values` |
| `dataset.provider_revisions` | Nonempty array of distinct `{provider_id, revision}`, exactly matching the trusted profile; at most 32 |
| `purpose_scope` | Exact exported `CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE` value below |
| `rights_basis.owner_id` | Accountable source-rights owner identity |
| `rights_basis.basis_reference` | Actual approval/license basis reference covering the entire declared dataset and uses; at most 1,000 characters |
| `rights_basis.approved_by` / `approved_at` | Accountable approver and genuine approval timestamp |
| `valid_from` / `expires_at` | Explicit finite grant-validity interval |
| `revoked_at` | Explicit `null` while authorized; any other value denies |
| `retention` | `immutable_originals_without_automated_deletion` |
| `exposures` | Exactly four booleans: `none` (must be true), `report_observation_summary`, `report_observation_members`, `report_observation_catalog` |

Timestamps are real UTC calendar timestamps with exactly six fractional digits:
`YYYY-MM-DDTHH:mm:ss.ffffffZ`. Approval must not be in the future; validity is
`valid_from <= database clock < expires_at`. Expiration/revocation blocks new
reads and retained-data reopens; it does **not** delete already immutable originals.
The owner basis must accommodate that storage behavior before authorization.

The fixed purpose is `neighborhood_cached_market_data` for
`core.sales_source_records` (`licensed_mls_source_records`), `core.sales`
(`canonical_sales`) and `core.sale_parcels` (`transaction_parcel_associations`),
in that order. `transaction_scope` is `transactions_intersecting_selection`,
`association_metadata` is `all_transaction_parcel_links`, `event_date_scope` is
`all_available_dates_for_seeded_transactions`; `additional_cadastral_accounts`
and `private_assignment_overlays` are false. Observation dates are analytical,
not entitlement filters. Custom's `knowledge_cutoff` must be null. The same
all-date, one-hop record/association scope applies to retained replay.

## Important integrated-dataset limitation

Current queries read integrated tables, not manual-import-only licensed rows.
`import_sales.py` can replace `source_sha256` while preserving earlier typed
values with `COALESCE`; filename history is not immutable per-field rights
lineage. A latest CSV SHA, import status or source label therefore cannot prove
rights for the complete row or association set. This policy intentionally has
no per-file allowlist, partial date grant or fabricated provider classification.

The operator must establish coverage of the **entire** queried source mix,
including legacy/canonical sales, prior merged fields and retained originals.
Trusted dataset/provider revisions identify that separately established scope;
they do not establish rights and this reader cannot independently prove which
provider produced every merged field. Production activation therefore also
requires controlled ingestion/inventory configuration: new sources (including
future Trestle data) must revise the trusted profile and require a matching new
owner grant, or have independently verified coverage. Updating only rows while
leaving the trusted inventory revision stale is not detected by this module.
Do not activate it where that source coverage cannot be established/enforced;
partial rights require real provenance/filtering work first. No automatic grant
for future imports is created here.

## Retained-context compatibility and bounds

Allowed results contain only `{allowed, decision_id, policy_revision}`. The
decision identifier binds organization and grant; the revision hashes the
complete validated configuration, not the requested exposure or selection.
Thus permitted summary/member/catalog reads can reopen the original capture,
but any accepted rights/configuration change changes the retained comparison
value. Dataset/provider mismatches deny outright. Configuration is read on each
check, including the coordinator's final check; no local grant cache masks
revocation. SQL bounds the returned metadata subtree to 16 KiB; the module also
enforces closed shallow shapes, text/provider limits and serialized bytes.
Database errors are replaced with a credential-free unavailable error.

This module adds no context, publication or acceptance structures. Existing
`customCohortContextCapture` capture/replay/present/inspect paths, exact context
repository and retained-graph loader remain authoritative for their existing
scope checks; the assessment publisher and atomic Custom acceptance writer are
unchanged. Production factory/router wiring and owner provisioning are separate.

Focused verification: `node --test test/customNeighborhoodSourcePolicy.test.js`
from `server`. Tests use explicitly synthetic owner grants, never production metadata.

The existing `customCohortContextCapture.integration.test.js` native CI wrapper
also runs `customNeighborhoodSourcePolicyDatabaseChecks` after the coordinator
fixture and before checkpoint persistence. It independently checks the policy
client's socket/database identity using the unchanged neighborhood test guard;
the policy helper rolls back all of its synthetic rights fixtures.

Eight real policy check groups passed in the local migrated run recorded at
workspace artifact
`outputs/custom-neighborhood-context-native-v1/e7c8dbd5ec424dbba173cbfbf96d0d5f.json`:
all four explicitly permitted exposures; bounded rights-subtree projection;
policy-revision/exposure changes; revocation; database-clock expiry; foreign/missing
organization grants; dataset/provider-mix mismatch; and the SQL size guard.
This tests the actual resolver against synthetic configured rights. It does not
establish real provider rights, ingestion provenance, production activation or a
completed remote CI run. See [checkpoint verification](custom-neighborhood-workspace-checkpoint.md#persistence-and-verification)
for the shared native sequence, retained evidence and remaining limits.
