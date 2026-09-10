# Custom neighborhood reported observations (v2)

This Custom-only path lets an appraiser review and apply a saved manual outline and the selected pockets' descriptive statistics as one report group. It does not change UAD v1 assessments, report calculations, authentication, or source configuration.

## User workflow

1. Open the exact saved appraisal file and its neighborhood workspace. Capture the broad study using the appraisal's actual effective date and observation period; optionally include a reviewed assignment-private sales CSV.
2. Include/exclude recorded groups. Choices are persisted separately from the accepted report. They do not silently change an existing report.
3. Draw and save the rough narrative boundary and its four cardinal descriptions. Native PostGIS validation checks topology and coverage of the retained subject point. A radius, automatic suggestion, cleared outline, or missing description is not silently accepted as the appraiser's boundary.
4. Select **Prepare report group**. The server reads the exact retained context and saved selection, calculates a proposal, then rechecks permissions, source-use rights, subject, boundary, workspace and editor revisions before publishing the immutable proposal and attachment.
5. Review the proposed outline, counts and low/median/high observations, including unavailable measures. Select **Apply boundary and statistics together**. Geography, selection, populations, statistics and evidence are saved in one transaction with the existing acceptance history/receipt.
6. The page reloads the checked accepted group from the database. PDF generation uses that group, not a new live query or browser draft.

The first-adoption path refuses a different already-populated report group. Replacing an accepted group requires a separate explicit whole-group replacement workflow; do not bypass this by reporting occupied fields as empty. A missing current section with retained acceptance history is also a conflict, not a new empty file.

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

## Activation and verification

This change does **not** enable the existing frontend feature flag or install organization grants. Existing shared/private observation rights are still required, plus an explicit `custom_neighborhood_report_observation_rights` grant for retaining/exporting this Custom report group. The report grant is default-deny and cannot be inferred from an upload review checkbox or an unrelated MLS subscription.

Before activation, run the canonical migration sequence and native publication/Apply/reopen tests, frontend production build and regression suites, then test the actual application with authorized source grants. Synthetic local tests are not evidence of successful production activation or provider permission.

Further capabilities—historical housing inventory, verified transaction consolidation, predominant valuation, reliability modeling, HOA/builder evidence and scheduled sales retention—must keep their own evidence and acceptance criteria. This descriptive profile does not invent those results.
