# Custom neighborhood reported observations (v2)

This Custom-only path lets an appraiser review and apply a saved manual outline and the selected pockets' descriptive statistics as one report group. It does not change UAD v1 assessments, report calculations, authentication, or source configuration.

## User workflow

1. Open the exact saved appraisal file and its neighborhood workspace. Capture the broad study using the appraisal's actual effective date and observation period; optionally include a reviewed assignment-private sales CSV.
2. Include/exclude recorded groups. Choices are persisted separately from the accepted report. They do not silently change an existing report.
3. Draw and save the rough narrative boundary and its four cardinal descriptions. Native PostGIS validation checks topology and coverage of the retained subject point. A radius, automatic suggestion, cleared outline, or missing description is not silently accepted as the appraiser's boundary.
4. Select **Prepare report group**. The server reads the exact retained context and saved selection, calculates a proposal, then rechecks permissions, source-use rights, subject, boundary, workspace and editor revisions before publishing the immutable proposal and attachment.
5. Review the proposed outline, counts and low/median/high observations, including unavailable measures. Select **Apply boundary and statistics together**. Geography, selection, populations, statistics and evidence are saved in one transaction with the existing acceptance history/receipt.
6. The page reloads the checked accepted group from the database. PDF generation uses that group, not a new live query or browser draft.

The first-adoption path refuses a different already-populated report group. To revise an accepted Custom v2 group, explicitly prepare a replacement, review its predecessor revision and proposed observations, then replace the boundary and statistics together. Preparing or cancelling a replacement does not change the accepted report. The old accepted group and section-history version remain retained after successful replacement.

Replacement is not a general overwrite permission: the owner must resolve the exact current acceptance and its complete five-part values/provenance at editor revision N. All five new parts advance together to N+1. A partial, foreign, altered, missing or non-v2 predecessor is a conflict, as is a missing current section with retained acceptance history. Existing v1 and UAD behavior is unchanged.

## What the data means

- CAD counts are **accounts**, not a verified count of economic properties or completed dwellings. Current CAD physical characteristics are explicitly capture-date reference observations.
- Sales counts are **source records**, not verified unique sale events. Shared database records and uploaded private records remain separate populations. No inferred deduplication, package-price allocation, or top-30 sampling is performed.
- Shared retained source-record associations preserve up to 1,000 account links per record within the existing 250,000-link publication budget. The separate private CSV review limit remains five matched accounts per record.
- Only eligible source-reported closing dates inside the selected study period and no later than the effective date enter the included sale populations. Future, undated and nonclosed records remain explained in retained dispositions. Ordinary marketing time can validly be zero.
- Closing price and current price are different observations. Unknown currency/area units, missing original closing prices, conflicting values and unsupported cumulative DOM remain unavailable. A newer raw file's units are not borrowed for an older preserved typed value.
- Exact decimal values are retained as bounded strings; UI/PDF formatting adds separators and at most two visible decimal places without unsafe conversion through floating point.
- A median is not renamed predominant value, dispersion is not labeled reliability, and exhausting the retained roster is not a claim of complete provider/city coverage.

For retrospective appraisals, the existing current-stock guard remains in force: a later current CAD mirror cannot stand in for historical inventory. An earlier reported closing uploaded later may still be inspected, but it does not establish historical neighborhood stock. No source-validity dates are fabricated from upload or sale dates.

## Persistence and recovery

Contract v2 uses the existing assessment, member, source, job and attachment tables. The new migration adds explicit observation-unit branches without rewriting v1 rows. Legacy property counters stay NULL for v2, while exact account counts are reconciled against retained member arrays. UAD attachments reject this Custom-only profile.

The browser sends identifiers, expected revisions and operation IDs, never computed report facts. Proposal/Apply retries retain their original UUIDs. A lost acknowledgement is not reported as success; unconfirmed Apply blocks exploration and Save Everything/signing until that same operation is resolved. A workspace-only reload cannot discard its retry identity. After a confirmed Apply, the barrier stays closed until the accepted report group is freshly read; a failed read offers reload-only recovery without a second Apply. An older initial file read cannot overwrite that newly accepted group. File/session switching invalidates old callbacks. Signed files are not overwritten.

An explicit replacement proposal uses the existing immutable job payload's version 2 to retain the predecessor acceptance identity, operation ID, accepted revision, canonical section hash and server-resolved evidence. The SQL JSONB editor hash is a separate concurrency fence, not that canonical hash. The closed section and receipt remain version 1; no predecessor column or new history table is needed. A retry checks its own already-committed successor before asking whether the predecessor is still current. It cannot replay an older acceptance over a newer group, and competing replacements of the same revision cannot both commit.

The additive request field is `replacement`. Preparation accepts `{kind: "accepted_custom_reported_group"}`. Apply requires that kind plus the exact server-returned `predecessor` containing `acceptance_id`, `operation_id`, `accepted_editor_revision` and `section_value_sha256`. Neither response includes this field for ordinary first adoption. The descriptor is a checked binding, not browser authority to supply replacement facts or an authorization decision.

Separate proposal operations also have separate server-authored evidence bindings. Cancelling a review and preparing the same selection again must not collide with the previous immutable job merely because its source data and clock reading match. Retrying the same operation still reuses its exact retained proposal. This does not change repository deduplication rules or substitute a new timestamp for the real derivation time.

## Activation and verification

### Dense retained contexts

The report consumer uses the same indexed observation engine and owner-admitted
mapping-v4 record allowance as capture/catalog/preview. Mapping-v2/v3 retain
their original 100,000-record limit; this is not a client-selectable limit.
Per-chunk, account-link, output-byte and publication budgets remain independent.
An oversized result is refused as a whole, never trimmed to a convenient sample.

For mapping-v4, each CAD publication member stores a versioned
`retained_account_observation_reference` instead of duplicating the entire
already-retained preview row. It includes the SHA-256 of that **full** row and
the exact state/value cells used for living area, site area and year built.
Calendar age is derived from that year using the appraisal effective year.
The population source binds the context reference, selected account-set digest,
selection revision, derivation and source snapshot hashes. The representation
is explicitly `retained-account-observation-reference-v1`.

To audit a compact member, reopen its authorized, hash-verified retained context,
rebuild the indexed observation row for its account and compare the full row
digest and the three exact cells. Raw conflicting values, parcel identities,
unused observations and original source routing remain bound by that digest;
they have not been deleted or replaced by a new fact. The shared-sale members
retain their existing full source-record evidence. Mapping-v2/v3 publication
bytes and all calculation/temporal semantics are unchanged.

The server yields between report-preparation phases with deadline/cancellation
checks. Retained input descendants are sealed before the first yield, and fresh
revision/rights checks still precede the publication transaction. Preparation
is not held inside a database transaction. This reduces event-loop starvation;
it is not a guarantee of instantaneous processing or a separate worker process.

The opt-in native dense fixture checks 38,106 accounts, 887 recorded groups and
more than 100,000 retained records under a 384 MiB V8 heap, with the real loopback
web host serving concurrent health requests. It verifies every compact account
reference and the complete publication roster. This preparation test performs
no report writes; native coordinator Apply/reopen tests and live QA acceptance
remain separate release checks.

This change does **not** enable the existing frontend feature flag or install organization grants. Existing shared/private observation rights are still required, plus an explicit `custom_neighborhood_report_observation_rights` grant for retaining/exporting this Custom report group. The report grant is default-deny and cannot be inferred from an upload review checkbox or an unrelated MLS subscription.

Before activation, run the canonical migration sequence and native publication/Apply/reopen tests, frontend production build and regression suites, then test the actual application with authorized source grants. Synthetic local tests are not evidence of successful production activation or provider permission.

Further capabilities—historical housing inventory, verified transaction consolidation, predominant valuation, reliability modeling, HOA/builder evidence and scheduled sales retention—must keep their own evidence and acceptance criteria. This descriptive profile does not invent those results.
