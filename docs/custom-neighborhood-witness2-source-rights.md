# Dormant witness2 source rights

`createCustomNeighborhoodWitness2SourcePolicy` is a parallel, server-only
evaluator. Nothing in this change installs it in the Custom owner, changes the
default source reader or report interpreter, or provisions organization metadata.
A mapping number, application role, retained witness, or interpretation profile
is not source permission.

## Exact, separate grant

The evaluator reads only the organization metadata subtree
`custom_neighborhood_witness2_source_rights_v1`. The installed legacy evaluator
continues reading `custom_neighborhood_source_rights`; its implementation,
accepted configuration, SQL arguments, decision/error bytes and canonical hash
semantics are unchanged. Literal regression goldens cover the legacy path.
Neither subtree is an upgrade, fallback, or substitute for the other.

The new grant has `policy_version: 1` and `purpose_version: 1`. Its fixed purpose
matches `describeNeighborhoodCombinedEvidenceMarketDataPurpose` exactly: the
existing all-date, complete one-hop source-association scope plus
`source_projection: { id: 'cached-combined-evidence-v1', mapping_version: 5,
witness_version: 2, fields: [...] }`. The field list is the exact ordered
31-field `CACHED_SALE_WITNESS_V2_FIELDS` vocabulary, including the three literal
price-currency aliases. Subsets, reordered fields, extra fields, different
versions, and older purposes are denied. The old evaluator likewise denies this
expanded purpose. Private assignment overlays remain outside this source grant.

An independently provisioned grant must cover
`integrated_cached_market_dataset` and
`entire_integrated_source_mix_including_prior_merged_values`, with the exact
server-configured dataset revision and complete approved provider/revision set.
It must identify the source-rights owner, approval identity, approval time and
basis reference. A new CSV or the current raw payload alone does not establish
rights to surviving values from the integrated provider mix. This module does
not decide provider field meanings, grant rights, or supply production approvals.

The factory accepts only the copied server-owned `datasetRevision` and
`providerRevisions`. Namespace, purpose, mapping version and witness vocabulary
are not caller options. Small private validation duplication is deliberate: the
legacy evaluator remains untouched rather than being generalized for this new
purpose.

## Fresh evaluation and exposure

Every decision uses the supplied bounded client to read the requested active
organization, its exact metadata subtree and PostgreSQL `clock_timestamp()`.
There is no authorization cache or transaction lifecycle ownership. Approval
must already be effective; validity is start-inclusive and expiry-exclusive,
checked at the database's current microsecond-resolution UTC time, not the
study's effective date. Revoked, missing, malformed, oversized, expired or
wrong-organization grants deny access. The metadata read and independent
canonical validation retain the 16,384-byte bound.

Immutable original retention and internal `none` exposure must be granted.
Each external exposure is independently explicit:

- `report_observation_summary`
- `report_observation_members`
- `report_observation_catalog`

The requested exposure is captured before the asynchronous read. A permitted
decision has revision
`custom-neighborhood-witness2-source-rights-v1:sha256:<canonical-config-hash>`.
Any accepted configuration change changes that exact configuration binding;
selection changes alone do not. Rechecks read the metadata and clock again.
Driver failures use the new sanitized policy-unavailable error, never a grant.

Later activation still requires explicit owner/composition integration and its
existing assignment, source, exposure, freshness and final-decision fences.
There are no policy writes, migrations, environment switches, source-cap changes
or live activation in this slice.
