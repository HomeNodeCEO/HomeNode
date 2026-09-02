# Property Tax Protest Workflow Boundary

Status: active persistence boundary and design contract.

## Purpose

Property Tax Protest, Custom Appraisal, and UAD 3.6 may eventually use the same
comparable-sales calculations and adjustment analysis, but they must never share
a writable workfile. Similar analysis does not imply shared record ownership.

| Workflow | Canonical writable record |
| --- | --- |
| Custom Appraisal | selected assignment file and Custom Appraisal workfile sections |
| UAD 3.6 | selected UAD workfile and its repeatable entities |
| Property Tax Protest | selected `app.tax_protest_files` record and `workfile_data` |

## Enforced invariants

- The Property Tax Protest page may read and write only the selected protest
  file. It must not call Custom Appraisal or UAD workfile loaders or mutations.
- A protest save includes its tax protest file identifier and exact expected
  revision. A revision conflict reloads the newer canonical record instead of
  overwriting it.
- File numbers are human-readable lineage identifiers. Isolation is enforced by
  the typed report target, opaque file identifier, account and organization
  scope, authorization, and optimistic revision checks—not by the display file
  number alone.
- Generated protest summaries use only persisted protest data. Missing evidence
  remains visibly missing; the UI must not create sample comparables, assumed
  adjustment support, or default cost-to-cure amounts.
- Mobile evidence enters a protest file only through the bounded Property Tax
  adapter and review flow. Custom Appraisal and UAD adapters remain separate.

## Shared comparable-analysis engine

The safe future architecture is a pure calculation core with workflow-specific
adapters:

1. A neutral input model contains subject facts, comparable facts, market data,
   adjustment rules, and calculation settings. It contains no workfile IDs and
   performs no persistence.
2. The engine returns calculated adjustments, indications, diagnostics, and
   provenance without saving anything.
3. A Custom Appraisal adapter maps its selected assignment into the neutral
   input and persists the result only to that Custom Appraisal workfile.
4. A Property Tax adapter maps its selected protest file into the same input and
   persists the result only to that protest file.
5. A UAD adapter remains responsible for UAD-specific validation and persistence.

The first shared calculation boundary is now implemented in
`dcad-frontend/src/lib/sharedComparableAnalysis.ts`. It accepts only subject
facts, comparable facts, supported adjustment rules, and provenance. It has no
file identifiers, HTTP calls, local storage, or database mutations. The Dallas
Property Tax adapter in `propertyTaxComparableAnalysis.ts` establishes the
eligible same-neighborhood sales universe, records exclusion reasons, ranks
physical similarity without using sale price, and only then calculates and
classifies adjusted indications.

If users later want to reuse an analysis from another workflow, that operation
must be an explicit copy/import. It should create a snapshot in the destination
with source workflow, source file ID, source revision, timestamp, and provenance.
The destination must never retain a live writable reference to the source.

## Current dependency status

The former protest page directly loaded and saved the Custom Appraisal
`sales_comparison` section. That dependency has been removed. The protest page
now derives evidence display and summaries from its selected canonical protest
file only. Custom Appraisal and UAD code paths are not modified by this boundary.

The complete interactive comparable-selection experience is still largely
implemented inside the Custom Appraisal UI. The new pure engine is the shared
foundation for progressively moving those calculations behind workflow-specific
adapters; copying that page's persistence code into Property Tax would violate
this contract.

The Dallas residential case and deadline configuration is versioned in
`dcad-frontend/src/lib/propertyTaxCase.ts`. It currently covers the 2026
single-family residential MVP, preserves a notice-specific deadline when one is
entered, calculates the district-evidence tracking date from the recorded
hearing date, and never transmits a filing or evidence request.

`dcad-frontend/scripts/testPropertyTaxIsolation.mjs` guards the page against
reintroducing the former cross-workflow imports and verifies deterministic
summary behavior.
