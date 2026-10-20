# UAD 3.6 second-worker handoff

## Goal

Prepare HomeNode to create structured appraisal assignments that can later
produce compliant UAD 3.6 MISMO XML and a matching dynamic URAR, while
preserving HomeNode's existing property, tax, market, comparable, and report
workflows.

## First work package: architecture review only

Create a branch named `uad/schema-architecture-review` and submit a pull
request containing documentation and diagrams, not production migrations.

The pull request should contain:

1. A schema inventory covering schemas, tables, columns, keys, foreign keys,
   constraints, indexes, views/functions, and approximate row counts.
2. A table map organized as:
   - keep as-is;
   - reuse/reference;
   - new shared appraisal structures;
   - new UAD-specific reference/validation structures;
   - do not duplicate.
3. A data-flow diagram for:
   `property -> assignment -> subject snapshot -> report type -> outputs`.
4. A proposed migration sequence with rollback/recovery notes.
5. A mapping of existing frontend/backend modules that can be shared.
6. Open questions and decisions requiring owner approval.

Sanitized schema metadata may be reviewed. Do not commit credentials,
production data, homeowner data, a production `.env`, or a live connection
string.

## Architecture constraints

- Do not create a separate UAD frontend, backend service, database, or user
  login.
- Do not replace the current property search or property report entry point.
- Do not duplicate property records for each report type.
- Do not run migrations or backfills against production.
- Do not modify the Dallas scraper or existing deployment dependencies.
- Do not begin XML/PDF generation until the canonical assignment model and UAD
  rule metadata have been reviewed.
- Treat `dcad-frontend/src/main.tsx` as the current routing entry point.

## UAD source discipline

Use only the current official Fannie Mae/Freddie Mac UAD 3.6 materials as
normative sources. Every implemented field, enumeration, conditional rule,
XPath, report label, and display rule must record its source appendix/version
and official identifier. Third-party summaries may help discovery but are not
authority.

The expected reference set includes the current delivery specification,
implementation and display guidance, report labels, official examples and
sample XML, report styling, appraisal-entry/reference rules, legacy mappings,
compliance rules, and the official UAD subschema/XSD. Confirm versions before
using them; do not assume an older local copy is current.

## Review boundaries

The HomeNode owner must approve:

- canonical assignment/report types and lifecycle;
- subject snapshot and source-provenance behavior;
- every migration;
- changes to shared comparable/adjustment calculations;
- production deployment, database execution, or external integrations;
- any deviation from ADR-001.

Automated checks must pass and CODEOWNERS review is required before merge.
