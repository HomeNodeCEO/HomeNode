# ADR-001: UAD 3.6 integration boundary

- Status: Accepted for architecture preparation
- Date: 2026-08-15

## Context

HomeNode already contains the property search, property report, assignment
details, documents, market analysis, comparable selection, adjustment studies,
valuation approaches, appraisal report draft, and property-tax protest
workflow. UAD 3.6 must reuse those capabilities without creating another
product or another copy of the property record.

## Decision

1. UAD 3.6 will be implemented inside the existing HomeNode monorepo and
   deployed through the existing HomeNode application.
2. The existing property/account data remains the shared property repository.
3. HomeNode will use one assignment/report core with at least these report
   types: custom appraisal, UAD 3.6, and property-tax protest.
4. Subject data, documents, photos, market analysis, comparable selections,
   adjustments, cost/income approaches, and reconciliation are shared
   appraisal modules. They must not be duplicated in UAD-only code.
5. Imported source observations remain separate from appraiser-verified
   assignment values and assignment snapshots.
6. The canonical appraisal/domain data is the source for both MISMO XML and
   the rendered URAR. Neither output is the database model.
7. The UAD field/rules model and validation engine precede final XML, PDF,
   compliance-API, and submission-package work.
8. The Dallas County scraper and non-UAD property enrichment pipelines remain
   operationally independent from UAD development.

## Initial implementation sequence

1. Inventory the current database and application ownership boundaries.
2. Produce a reviewed keep/reuse/new/do-not-duplicate schema map.
3. Approve the canonical assignment and subject-snapshot model.
4. Add migrations in a separate pull request; do not apply them automatically.
5. Add the create-assignment workflow and editable subject verification.
6. Add UAD reference metadata and conditional validation.
7. Add MISMO XML and XSD/subschema validation.
8. Add the URAR renderer from the same canonical data.
9. Add compliance and packaging integrations after authorization is available.

## Consequences

- UAD development stays modular without creating a separate service or site.
- Existing appraisal work can be reused by all report types.
- Database and compliance decisions receive review before they affect
  production.
- Some existing large UI components will eventually need extraction into
  shared domain services/components, but that refactor is staged rather than
  performed during initial schema review.
