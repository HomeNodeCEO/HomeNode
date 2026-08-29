# UAD 3.6 specification refresh and workflow audit — 2026-08-29

This audit reviews HomeNode's UAD 3.6 implementation against the current
public GSE technical material and Fannie Mae policy available on August 29,
2026. It is an engineering control assessment, not a legal opinion, appraisal
review, lender approval, or substitute for GSE ACPT/onboarding results.

The audit is limited to the UAD workspace. It does not change Custom Appraisal
or Property Tax data, calculations, routes, or report output.

## Official baseline checked

- Fannie Mae's current UAD page lists Appendices A through H, the UAD 3.6
  subschema, separate Restricted Appraisal Update and Completion Report
  specifications, updated FAQs dated August 18, 2026, and the November 2, 2026
  mandate for new UCDP submissions.
- The pinned HomeNode runtime release remains
  `uad-3.6-2026-08-13-h1.5`: Appendix A-1 v1.4, Appendix H-1 v1.5, and UAD
  subschema v1.3.
- The current Freddie Mac Appendix H-1 workbook was downloaded independently
  during this refresh. Its SHA-256 digest exactly matches the executable-source
  digest pinned in `server/src/modules/uad/spec/manifest.json`.
- Fannie Mae's CDN refused the automated binary refresh requests. Therefore,
  the audit confirmed the current official version labels and policy pages, but
  retained the already pinned Fannie binary digests rather than claiming a new
  byte-for-byte verification for every Appendix archive.

## Workflow and engine findings

| Area | Finding | Control/status |
| --- | --- | --- |
| Assignment identity | Compliant-by-design foundation | Each UAD file has its own canonical records and revision history. Shared property data is source evidence, not a permanently shared appraisal conclusion. |
| Custom-to-UAD reuse | Acceptable with human control | Same-assignment, frozen-snapshot suggestions require explicit appraiser selection and confirmation. Existing UAD values win conflicts. Suggestions do not auto-apply. |
| Mobile evidence | Acceptable with verification | Photos/sketches are assignment-linked, privately stored, checksum verified, and remain evidence until the appraiser classifies/confirms the related UAD facts. |
| Comparable/market engines | Acceptable with continuing guardrails | Search, ranking, boundary, market, and adjustment tools may assist the appraiser, but must preserve sources and effective dates, remain explainable, and never select data to reach a desired value. No prohibited protected-class, crime-rate, or subjective neighborhood terminology was found in the application source review. |
| Adjustment calculations | Acceptable with appraiser responsibility | Server calculations are deterministic and traceable; HomeNode does not impose obsolete net/gross percentage caps. Support and reconciliation remain required. |
| Sign/export | Strong foundation | Signing is tied to authenticated roles and the current revision; signed/exported records are immutable and artifacts are revision-bound. Local validation does not claim GSE equivalence. |
| Submission | Correctly separated | HomeNode generates a package but does not submit to UCDP. Compliance API and lender delivery remain separately controlled external workflows. |

The shared engines must continue to obey these non-negotiable rules:

1. Never infer or use race, color, religion, sex, disability, familial status,
   national origin, crime rate, or a proxy for a protected class in selection,
   adjustment, market-area, or value logic.
2. Never optimize comparable selection, adjustments, or reconciliation to a
   requested/target value.
3. Record the source, source identifier, observation/effective date, and any
   appraiser override needed to reproduce a result.
4. Treat imported characteristics as suggestions against the current
   assignment snapshot. Never overwrite current inspection evidence with a
   prior appraisal merely because the property identity matches.
5. Require the signing appraiser to resolve conflicts, confirm conclusions,
   and own the scope of work and final report.

## Corrections added by this refresh

The application now fails closed at section completion and final validation for
the following conditions:

- an Exterior Appraisal selected for a Fannie-targeted report;
- a Traditional Appraisal without physical interior and exterior inspections;
- an applicable attached/detached single-family sketch using AMS instead of
  ANSI Z765-2021, unless the appraiser selects another controlling standard and
  explains how it was applied;
- a missing property-access street scene;
- a missing mixed-use/non-residential-use photo;
- a missing photo for each beneficial or adverse view;
- a missing subject rear photo or a missing front photo for any dwelling;
- a missing subject Property Photo in the Sales Comparison Approach;
- a developed Sales Comparison Approach with fewer than three closed sales;
- a developed Sales Comparison Approach without a Sales Comparable Map;
- a Sales Comparison indicated value outside the adjusted-price range;
- new construction with kitchen, bathroom, or overall bathroom/flooring update
  status other than Fully Updated;
- an Income or Cost Approach marked developed while HomeNode lacks the native
  UAD Section 24 or 25 analysis; and
- a two- to four-unit or manufactured-home assignment that would require the
  currently unavailable native income or cost workflow.

These are deliberate blockers. Copying an indicated value from Custom
Appraisal does not replace the UAD data, comparable detail, calculations,
commentary, and exhibits required by the applicable native section.

## Current supported production candidate

The supportable first appraisal remains a one-unit, site-built single-family
property using an eligible Traditional, Hybrid, or Desktop scope as authorized
by the lender/DU result. For the first manual test, use a Traditional Appraisal
with physical interior and exterior inspection, no manufactured home, one
living unit excluding ADUs, and both Income and Cost Approach indicators set to
No with supported exclusion reasons.

## Known scopes that remain blocked or incomplete

- Section 23 Rental Information and Section 24 Income Approach are not native.
- Section 25 Cost Approach is not native.
- Restricted Appraisal Update and Completion Reports require their own A-2/A-3,
  B-2/B-3, F-2/F-3, and H-2/H-3 implementations; URAR generation is not a
  substitute.
- Significant real property appraisal assistance needs a native PARTY/ROLE
  editor and XML relationship support before that scenario is accepted.
- Compliance API ACPT/nonproduction credentials and assigned GSE scenarios are
  external gates. A local XSD pass or local Appendix H finding count must not be
  represented as a GSE acceptance result.
- Lender/AMC portal delivery is an operational adapter concern after the
  appraisal package itself passes the applicable GSE and lender requirements.

## Evidence and next gate

The focused server suite includes policy regressions for the new blockers. The
normal full server, frontend build, delivery, XML/subschema, security, and
migration suites remain required in CI.

After this change is deployed to staging, complete the first full one-unit SFR
manually, including at least three closed sales, source verification,
adjustments, weighting commentary, required photos, the sales map, sketch,
signed PDF, XML, and ZIP inspection. External compliance claims must wait for
the GSE-assigned nonproduction scenarios.

## Primary sources

- Fannie Mae UAD 3.6 documentation landing page:
  https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset
- Fannie Mae UAD 3.6 Policy, published August 5, 2026:
  https://singlefamily.fanniemae.com/media/document/pdf/fannie-mae-selling-guide-supplement-uniform-appraisal-dataset-uad-36-policy
- Fannie Mae Photo and Image Job Aid:
  https://singlefamily.fanniemae.com/media/47671/display
- Freddie Mac UAD resources:
  https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/uad
