# Custom retained decision-evidence binding v1

`customCohortDecisionEvidence.js` is an internal pure adapter from an existing
`cohortDecisionCommand` v1 to an owner-loaded retained Custom context. It makes
the command's evidence addresses executable. It does not record a decision,
authorize a reviewer, establish provider field meaning, mark a fact supported,
publish an assessment, or enable Apply.

## Entry point

```js
const resolver = createCustomCohortDecisionEvidenceResolver({
  context_header_json,
  expected: { context_ref, target, observation_period },
  retained_inputs,
  selection: { revision, included_recorded_group_ids },
});
const reference = resolver.deriveEvidenceRef(sourceRef, recordId);
const evidence = resolver.resolveEvidenceRef(JSON.stringify(reference));
const bound = resolver.bindCommand(originalCommandJson);
```

The factory accepts exactly the current assessment-preparation input and calls
`prepareCustomCohortAssessmentPreparation` rather than copying its validators.
This rechecks plain data, exact header/scope/context, all four retained dependency
hashes, original capture identity, subject target/effective date, study period,
and recorded-group selection. It therefore currently shares preparation's v2
capture, numeric-preview, and catalog admission limits. It is not a universal
adapter for old captures or independent studies.

The owner must load the header and graph from the real repositories under the
proper authenticated, source-policy-checked target and freshness fences. Valid
hashes supplied by an arbitrary caller do not establish original acquisition or
truth. The binder does not connect to a database, fetch current CAD/MLS rows, or
accept `verified`, `supported`, actor, or authorization booleans.

## Explicit identity adapter

No existing persisted study registry or command-shaped source manifest is
implied. Adapter v1 defines the following mappings:

| Command identity | Exact retained value |
| --- | --- |
| `study_ref.study_id` | Context UUID |
| `study_ref.definition_revision` | String `"1"` |
| `study_ref.definition_sha256` | Header `study_input.content_sha256` |
| `capture_id` | Source payload `metadata.id` |
| `capture_revision` | Source payload `metadata.revision` |
| `manifest_sha256` | Header `selection_input.content_sha256`, the retained graph's exact selection/source directory root |
| `chunk_id` | Source `id` |
| `chunk_sha256` | Exact source snapshot payload hash |
| `record_key` | Outer retained row `record_id` |
| `record_content_sha256` | SHA-256 of `canonicalAssessmentJson` of the complete outer retained `{record_id,data}` row |

The record hash includes the entire mapping wrapper: normalized data,
`raw_projection`, and capability gaps. It is not the mutable database
`source_record_hash`, an import file SHA, or a digest of selected normalized
fields. Here a captured transaction's outer key is, for example, `source:10`;
the nested mapper key such as `core.sales_source_records:10` is not interchangeable.

`capture_candidate` subjects use exact outer transaction-role record keys.
`stock_member` subjects use exact strings in the captured discovery roster, not
coerced account aliases or linked-only accounts. Target, context and study must
match the adapter binding exactly. All root evidence references must resolve;
the unchanged command grammar requires nested evidence references to be closed
over that root list.

## Results and scope

`resolver.binding` is frozen `{context_ref,target_ref,study_ref}`.
`resolveEvidenceRef` takes bounded primitive JSON and returns a detached frozen
`{evidence_ref,role,record}`. `record` includes private/raw retained projection
values; this result is internal and must not be sent to a browser without its
own authorized, bounded presentation contract.

`bindCommand` runs the unchanged primitive-JSON command grammar. A successful
result has:

```js
{
  binding_version: 1,
  status: 'bound',
  validation_scope: 'retained_evidence_binding_only',
  authority: 'not_established',
  binding, command, resolved_evidence,
  claim_observation,
  runtime_requirements: {
    authorization: 'not_checked', provider_rights: 'not_checked',
    subject_freshness: 'not_checked', generation: 'not_checked',
    predecessor: 'not_checked', decision_references: 'not_checked',
  },
  assessment: null,
  apply: { status: 'blocked', reason: 'supported_fact_resolver_unavailable' },
}
```

The normalized command and all results are detached/frozen. The record index
stores admitted canonical bytes, so later mutation of the factory input cannot
change resolution. No client object is accepted in place of original command
JSON; reserializing an already parsed HTTP body does not prove original bytes.

Only `closing_date` currently compares a claimed value. It checks retained raw
`sale_closing_date` and `source_close_date` values, preserving their presence,
blanks, invalid values and conflicts. It uses the candidate's captured canonical
ID when available, never a different event for the same account. Its diagnostic
reports `matched`, `conflicting_evidence`, `missing_evidence`, `claim_mismatch`,
or `not_evaluated` for an unknown claim, with exact observed/missing/invalid field
counts. A known claim must cite its exact candidate in `event_evidence_refs`;
missing one of the two date fields remains missing, not a canonical fallback.
`matched` means only agreement with these stored columns. It does not prove
that a sale closed, that a provider used those field meanings, currency, economic
property equivalence, temporal housing facts, or market eligibility.

The current real closure contract rejects duplicate canonical sale IDs before
retention; it is not bypassed to manufacture contradictory fixtures. The binder
also defensively examines the full captured canonical-row group. Root/nested
support references for other claims are address-bound only: their relevance,
secondary subject semantics, decision-reference existence, generation CAS,
predecessor identity and reviewer authority remain for their owner/meaning
resolvers. No supplied boolean makes them facts.

Malformed commands/addresses/bindings throw a fixed `TypeError` with code
`CUSTOM_COHORT_DECISION_EVIDENCE_INVALID` and a fixed reason. Factory admission
failures are sanitized as `retained_input_invalid`. Missing/conflicting date
observations are valid diagnostic results, not thrown or silently repaired.
Commands inherit their 64 KB and 64-reference grammar budgets; raw record index
bytes inherit the 192 MB retained-graph cap. Results are capped at 8 MiB, with
record-byte preflight and no clipped evidence. This is not a browser response
budget or a request to persist all resolved raw records in each ledger entry.

## Verification

`server/test/customCohortDecisionEvidence.test.js` exercises the actual
subject/spatial/source builders and immutable persistence/reopen using shared
`decisionEvidenceFixture` query fakes. It checks every reference field, wrong
target/context/study/subject, altered raw bytes, different genuine retained
captures, mutation after admission, missing/invalid/conflicting dates, unsupported
claims, preserved null/false/zero values, hostile inputs, and a 35-record,
multi-chunk response exceeding the canonicalizer's per-document 2 MB ceiling.
The fixture exposes the real preparation input, fake repository/client/blob
store and first transaction locator for further owner/meaning tests. These are
unit/composition checks, not native PostgreSQL, authorization, concurrency,
provider-rights, or report-readiness evidence.

Focused command from the repository root:

```text
node --test server/test/customCohortDecisionEvidence.test.js
```
